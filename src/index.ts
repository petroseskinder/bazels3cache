import * as http from "http";
import * as AWS from "aws-sdk";
import * as debug_ from "debug";
import * as minimist from "minimist";
import * as winston from "winston";
import { Args, Config, getConfig, validateConfig } from "./config";
import { Cache } from "./memorycache";

const debug = debug_("bazels3cache");

// just the ones we need...
enum StatusCode {
    OK = 200,
    Forbidden = 403,
    NotFound = 404,
    MethodNotAllowed = 405
}

const hostname = "localhost";

function logProps(
    req: http.ServerRequest,
    res: http.ServerResponse,
    attrs: {
        startTime: Date;
        responseLength: number;
        fromCache?: boolean;
        awsPaused: boolean;
    }
) {
    const endTime = new Date();
    const elapsedMillis = endTime.getTime() - attrs.startTime.getTime();
    const loglineItems = [
        req.method,
        req.url,
        res.statusCode,
        attrs.responseLength,
        `${elapsedMillis}ms`,
        attrs.fromCache && "(from cache)",
        attrs.awsPaused && "(aws paused)"
    ];
    const logline = loglineItems
        .filter(item => ["string", "number"].indexOf(typeof item) !== -1)
        .join(" ");
    debug(logline);
    winston.info(logline);
}

function sendResponse(
    req: http.ServerRequest,
    res: http.ServerResponse,
    body: Buffer | string,
    attrs: {
        startTime: Date;
        fromCache?: boolean;
        awsPaused: boolean;
    }
) {
    let responseLength: number;
    if (body instanceof Buffer) {
        responseLength = body.byteLength;
    } else if (typeof body === "string") {
        responseLength = body.length;
    } else {
        responseLength = 0;
    }

    logProps(req, res, {
        startTime: attrs.startTime,
        responseLength,
        fromCache: attrs.fromCache,
        awsPaused: attrs.awsPaused
    });
    res.end.apply(res, body ? [body] : []);
}

function isIgnorableError(err: AWS.AWSError) {
    // TODO add a comment explaining this
    return err.retryable === true;
}

function shouldIgnoreError(err: AWS.AWSError, config: Config) {
    return config.allowOffline && isIgnorableError(err);
}

function getHttpResponseStatusCode(
    err: AWS.AWSError,
    codeIfIgnoringError: StatusCode,
    config: Config
) {
    if (shouldIgnoreError(err, config)) {
        return codeIfIgnoringError;
    } else {
        return err.statusCode || StatusCode.NotFound;
    }
}

function prepareErrorResponse(
    res: http.ServerResponse,
    err: AWS.AWSError,
    codeIfIgnoringError: StatusCode,
    config: Config
) {
    res.statusCode = getHttpResponseStatusCode(err, codeIfIgnoringError, config);
    res.setHeader("Content-Type", "application/json");
    res.write(JSON.stringify(err, null, "  "));
}

function startServer(s3: AWS.S3, config: Config) {
    const cache = new Cache(config); // in-memory cache
    let idleTimer: NodeJS.Timer;
    let awsPauseTimer: NodeJS.Timer;
    let awsErrors = 0;
    let awsPaused = false;

    function onAWSError(req: http.ServerRequest, s3error: AWS.AWSError) {
        const message = `${req.method} ${req.url}: ${s3error.message || s3error.code}`;
        debug(message);
        winston.error(message);
        winston.verbose(JSON.stringify(s3error, null, "  "));
        if (++awsErrors >= config.errorsBeforePausing) {
            winston.warn(
                `Encountered ${awsErrors} consecutive AWS errors; pausing AWS access for ${
                    config.pauseMinutes
                } minutes`
            );
            awsPaused = true;
            awsPauseTimer = setTimeout(() => {
                winston.warn("Unpausing AWS access; attempting to resume normal caching");
                awsPaused = false;
                awsErrors = 0;
                awsPauseTimer = null;
            }, config.pauseMinutes * 60 * 1000);
        }
    }

    function onAWSSuccess() {
        awsErrors = 0;
    }

    function shutdown(logMessage: string) {
        if (logMessage) {
            winston.info(`Idle for ${config.idleMinutes} minutes; terminating`);
        }
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = undefined;
        }
        if (awsPauseTimer) {
            clearTimeout(awsPauseTimer);
            awsPauseTimer = undefined;
        }
        server.close();
    }

    const server = http.createServer((req: http.ServerRequest, res: http.ServerResponse) => {
        if (idleTimer) {
            clearTimeout(idleTimer);
        }
        if (config.idleMinutes) {
            idleTimer = setTimeout(() => {
                shutdown(`Idle for ${config.idleMinutes} minutes; terminating`);
            }, config.idleMinutes * 60 * 1000);
        }

        const startTime = new Date();
        const s3key = req.url.slice(1); // remove leading "/"

        switch (req.method) {
            case "GET": {
                if (s3key === "ping") {
                    sendResponse(req, res, "pong", { startTime, awsPaused });
                } else if (s3key === "shutdown") {
                    sendResponse(req, res, "shutting down", { startTime, awsPaused });
                    shutdown("Received 'GET /shutdown'; terminating");
                } else if (cache.contains(s3key)) {
                    // we already have it in our in-memory cache
                    sendResponse(req, res, cache.get(s3key), {
                        startTime,
                        fromCache: true,
                        awsPaused
                    });
                } else if (awsPaused) {
                    res.statusCode = StatusCode.NotFound;
                    sendResponse(req, res, null, { startTime, awsPaused });
                } else {
                    const s3request = s3
                        .getObject({
                            Bucket: config.bucket,
                            Key: s3key
                        })
                        .promise();

                    s3request
                        .then(data => {
                            cache.maybeAdd(s3key, <Buffer>data.Body); // safe cast?
                            sendResponse(req, res, <Buffer>data.Body, {
                                // safe cast?
                                startTime,
                                awsPaused
                            });
                            onAWSSuccess();
                        })
                        .catch((err: AWS.AWSError) => {
                            // 404 is not an error; it just means we successfully talked to S3
                            // and S3 told us there was no such item.
                            if (err.statusCode === StatusCode.NotFound) {
                                onAWSSuccess();
                            } else {
                                onAWSError(req, err);
                            }
                            // If the error is an ignorable one (e.g. the user is offline), then
                            // return 404 Not Found.
                            prepareErrorResponse(res, err, StatusCode.NotFound, config);
                            sendResponse(req, res, null, { startTime, awsPaused });
                        });
                }
                break;
            }

            case "PUT": {
                if (req.url === "/") {
                    res.statusCode = StatusCode.Forbidden;
                    sendResponse(req, res, null, { startTime, awsPaused });
                } else {
                    const body: Buffer[] = [];
                    req.on("data", (chunk: Buffer) => {
                        body.push(chunk);
                    });
                    req.on("end", () => {
                        const fullBody = Buffer.concat(body);
                        cache.maybeAdd(s3key, fullBody);
                        if (awsPaused) {
                            res.statusCode = StatusCode.OK;
                            sendResponse(req, res, null, { startTime, awsPaused });
                        } else {
                            const s3request = s3
                                .putObject({
                                    Bucket: config.bucket,
                                    Key: s3key,
                                    Body: fullBody,
                                    // Very important: The bucket owner needs full control of the uploaded
                                    // object, so that they can share the object with all the appropriate
                                    // users
                                    ACL: "bucket-owner-full-control"
                                })
                                .promise();
                            s3request
                                .then(() => {
                                    sendResponse(req, res, null, { startTime, awsPaused });
                                    onAWSSuccess();
                                })
                                .catch((err: AWS.AWSError) => {
                                    onAWSError(req, err);
                                    // If the error is an ignorable one (e.g. the user is offline), then
                                    // return 200 OK -- pretend the PUT succeeded.
                                    prepareErrorResponse(res, err, StatusCode.OK, config);
                                    sendResponse(req, res, null, { startTime, awsPaused });
                                });
                        }
                    });
                }
                break;
            }

            case "HEAD": {
                if (cache.contains(s3key)) {
                    sendResponse(req, res, null, { startTime, fromCache: true, awsPaused });
                } else if (awsPaused) {
                    res.statusCode = StatusCode.NotFound;
                    sendResponse(req, res, null, { startTime, awsPaused });
                } else {
                    const s3request = s3
                        .headObject({
                            Bucket: config.bucket,
                            Key: s3key
                        })
                        .promise();

                    s3request
                        .then(data => {
                            sendResponse(req, res, null, { startTime, awsPaused });
                            onAWSSuccess();
                        })
                        .catch((err: AWS.AWSError) => {
                            onAWSError(req, err);
                            // If the error is an ignorable one (e.g. the user is offline), then
                            // return 404 Not Found.
                            prepareErrorResponse(res, err, StatusCode.NotFound, config);
                            sendResponse(req, res, null, { startTime, awsPaused });
                        });
                }
                break;
            }

            default: {
                res.statusCode = StatusCode.MethodNotAllowed;
                sendResponse(req, res, null, { startTime, awsPaused });
            }
        }
    });

    server.on("error", e => {
        const message = `could not start server: ${e.message}`;
        winston.error(message);
        console.error(`bazels3cache: ${message}`);
        process.exitCode = 1;
    });

    server.listen(config.port, hostname, () => {
        debug(`started server at http://${hostname}:${config.port}/`);
        winston.info(`started server at http://${hostname}:${config.port}/`);
        console.log(`bazels3cache: server running at http://${hostname}:${config.port}/`);
    });
}

function initLogging(config: Config) {
    winston.configure({
        level: config.logging.level,
        transports: [
            new winston.transports.File({
                filename: config.logging.file,
                json: false
            })
        ],
        padLevels: true
    });
}

function main(args: Args) {
    const config = getConfig(args);
    initLogging(config); // Do this early, because when logging doesn't work, we're flying blind

    const configErrorMessage = validateConfig(config);
    if (configErrorMessage) {
        console.error(`bazels3cache: ${configErrorMessage}`);
        winston.error(configErrorMessage);
        process.exitCode = 1;
        return;
    }

    winston.info("starting");
    process.on("exit", exitCode => winston.info(`terminating with exit code ${exitCode}`));
    process.on("uncaughtException", function(err) {
        console.error("bazels3cache: Uncaught exception:", err);
        winston.error(`bazels3cache: Uncaught exception: ${err}`);
        process.exit(1); // hard stop
    });

    const chain = new AWS.CredentialProviderChain(null);
    chain
        .resolvePromise()
        .then(credentials => {
            AWS.config.credentials = credentials;
            const s3 = new AWS.S3({
                apiVersion: "2006-03-01",
                credentials
            });
            startServer(s3, config);
        })
        .catch((err: AWS.AWSError) => {
            const message = `Could not resolve AWS credentials: ${err.message}`;
            console.error(`bazels3cache: ${message}`);
            winston.error(message);
            process.exitCode = 1;
        });
}

main(minimist<Args>(process.argv.slice(2)));
