
module.exports = function (RED) {
    "use strict";
    var Ntwitter = require('twitter-ng');
    var request = require('request');
    var crypto = require('crypto');
    // var fileType = require('file-type');
    var twitterRateTimeout;
    var retry = 60000; // 60 secs backoff for now

    var localUserCache = {};
    var userObjectCache = {};
    var userSreenNameToIdCache = {};

    function TwitterCredentialsNode(n) {
        RED.nodes.createNode(this, n);
        this.screen_name = n.screen_name;
        if (this.screen_name && this.screen_name[0] === "@") {
            this.screen_name = this.screen_name.substring(1);
        }
        if (this.credentials.access_token_bearer) {
            this.oauth = {
                token: this.credentials.access_token_bearer
            }
            this.credHash = crypto.createHash('sha1').update(
                this.credentials.access_token_bearer
            ).digest('base64');
            var self = this;
        }
    }

    RED.nodes.registerType("twitter-credentials", TwitterCredentialsNode, {
        credentials: {
            access_token_bearer: { type: "password" }
        }
    });
    TwitterCredentialsNode.prototype.get = function (url, opts) {
        var node = this;
        opts = opts || {};
        opts.tweet_mode = 'extended';
        return new Promise(function (resolve, reject) {
            request.get({
                url: url,
                oauth: node.oauth,
                json: true,
                qs: opts
            }, function (err, response, body) {
                if (err) {
                    reject(err);
                } else {
                    resolve({
                        status: response.statusCode,
                        rateLimitRemaining: response.headers['x-rate-limit-remaining'],
                        rateLimitTimeout: 5000 + parseInt(response.headers['x-rate-limit-reset']) * 1000 - Date.now(),
                        body: body
                    });
                }
            });
        })
    }

    function TwitterInNode(n) {
        RED.nodes.createNode(this, n);
        this.active = true;
        this.user = n.user;
        //this.tags = n.tags.replace(/ /g,'');
        var streamm;
        this.tags = n.tags || "";
        this.twitter = n.twitter;
        this.topic = "tweets";
        this.twitterConfig = RED.nodes.getNode(this.twitter);
        this.poll_ids = [];
        this.timeout_ids = [];
        var credentials = RED.nodes.getCredentials(this.twitter);
        this.status({});

        if (this.twitterConfig.oauth) {
            var node = this;
            if (this.user === "true") {
                // Poll User Home Timeline 1/min
                this.poll(60000, "https://api.twitter.com/1.1/statuses/home_timeline.json");
            } else if (this.user === "user") {
                var users = node.tags.split(/\s*,\s*/).filter(v => !!v);
                if (users.length === 0) {
                    node.error(RED._("twitter.warn.nousers"));
                    return;
                }
                // Poll User timeline
                users.forEach(function (user) {
                    node.poll(60000, "https://apitwitter.com/1.1/statuses/user_timeline.json", { screen_name: user });
                })
            } else if (this.user === "dm") {
                node.pollDirectMessages();
            } else if (this.user === "event") {
                this.error("This Twitter node is configured to access a user's activity stream. Twitter removed this API in August 2018 and is no longer available.");
                return;
            } else if (this.user === "false") {
                var twit = new Ntwitter({
                    access_token_bearer: credentials.access_token_bearer
                });

                // Stream public tweets

                const needle = require('needle');

                // The code below sets the bearer token from your environment variables
                // To set environment variables on macOS or Linux, run the export command below from the terminal:
                // export BEARER_TOKEN='YOUR-TOKEN'
                const token = credentials.access_token_bearer;

                const rulesURL = 'https://api.twitter.com/2/tweets/search/stream/rules';
                const streamURL = 'https://api.twitter.com/2/tweets/search/stream';

                // this sets up two rules - the value is the search terms to match on, and the tag is an identifier that
                // will be applied to the Tweets return to show which rule they matched
                // with a standard project with Basic Access, you can add up to 25 concurrent rules to your stream, and
                // each rule can be up to 512 characters long

                // Edit rules as desired below
                const rules = [{
                    'value': node.tags,
                    'tag': node.tags
                }];


                async function getAllRules() {

                    const response = await needle('get', rulesURL, {
                        headers: {
                            "authorization": `Bearer ${token}`
                        }
                    })

                    if (response.statusCode !== 200) {
                        node.send("Error:", response.statusMessage, response.statusCode)
                        throw new Error(response.body);
                    }

                    return (response.body);
                }

                async function deleteAllRules(rules) {

                    if (!Array.isArray(rules.data)) {
                        return null;
                    }

                    const ids = rules.data.map(rule => rule.id);

                    const data = {
                        "delete": {
                            "ids": ids
                        }
                    }

                    const response = await needle('post', rulesURL, data, {
                        headers: {
                            "content-type": "application/json",
                            "authorization": `Bearer ${token}`
                        }
                    })

                    if (response.statusCode !== 200) {
                        throw new Error(response.body);
                    }

                    return (response.body);

                }

                async function setRules() {

                    const data = {
                        "add": rules
                    }

                    const response = await needle('post', rulesURL, data, {
                        headers: {
                            "content-type": "application/json",
                            "authorization": `Bearer ${token}`
                        }
                    })

                    if (response.statusCode !== 201) {
                        throw new Error(response.body);
                    }

                    return (response.body);

                }

                function streamConnect(retryAttempt) {

                    const stream = needle.get(streamURL, {
                        headers: {
                            "User-Agent": "v2FilterStreamJS",
                            "Authorization": `Bearer ${token}`
                        },
                        timeout: 20000
                    });

                    stream.on('data', data => {
                        node.status({fill:"green", shape:"dot", text:(tags||" ")});
                        try {
                            const json = JSON.parse(data);
                            // console.log(json);
                            node.send({topic:"tweet",payload:json.data.text});

                            // A successful connection resets retry count.
                            retryAttempt = 0;
                        } catch (e) {
                            if (data.detail === "This stream is currently at the maximum allowed connection limit.") {
                                console.log(data.detail)
                                process.exit(1)
                            } else {
                                // Keep alive signal received. Do nothing.
                            }
                        }
                    }).on('err', error => {
                        if (error.code !== 'ECONNRESET') {
                            console.log(error.code);
                            process.exit(1);
                        } else {
                            // This reconnection logic will attempt to reconnect when a disconnection is detected.
                            // To avoid rate limits, this logic implements exponential backoff, so the wait time
                            // will increase if the client cannot reconnect to the stream. 
                            setTimeout(() => {
                                console.warn("A connection error occurred. Reconnecting...")
                                streamConnect(++retryAttempt);
                                node.status({fill:"red", shape:"ring", text:RED._("twitter.errors")});
                            }, 2 ** retryAttempt)
                        }
                    }).on('limit', limit => {
                        //node.status({fill:"grey", shape:"dot", text:RED._("twitter.errors.limitrate")});
                        node.status({fill:"grey", shape:"dot", text:(tags||" ")});
                    });

                    return stream;

                }
        
                try {
                    var thing = 'statuses/filter';
                    var tags = node.tags;
                    var st = { track: [tags] };

                    var setupStream = function() {
                        if (node.restart) {
                            (async () => {
                                let currentRules;
                                    console.warn = ({topic:"warning",payload:node.restart})
                                try {
                                    // Gets the complete list of rules currently applied to the stream
                                    currentRules = await getAllRules();
            
                                    // Delete all rules. Comment the line below if you want to keep your existing rules.
                                    await deleteAllRules(currentRules);
            
                                    // Add rules to the stream. Comment the line below if you don't want to add new rules.
                                    await setRules();
            
                                } catch (e) {
                                    console.error(e);
                                    process.exit(1);
                                }
            
                                // Listen to the stream.
                                // node.status({fill:"green", shape:"dot", text:(node.tags||" ")});
                                console.log("Twitter API is steraming public tweets with search term "+node.tags||" ");
                                streamm=streamConnect(0);

                            // node.status({fill:"green", shape:"dot", text:(tags||" ")});

                            })();
                            
                        }
                    }

                    // if 4 numeric tags that look like a geo area then set geo area
                    var bits = node.tags.split(",");
                    if (bits.length == 4) {
                        if ((Number(bits[0]) < Number(bits[2])) && (Number(bits[1]) < Number(bits[3]))) {
                            st = { locations: node.tags };
                            node.log(RED._("twitter.status.using-geo",{location:node.tags.toString()}));
                        }
                    }

                    // all public tweets
                    if (this.user === "false") {
                        node.on("input", function(msg) {
                            if (this.tags === '') {
                                if (node.tout) { clearTimeout(node.tout); }
                                if (node.tout2) { clearTimeout(node.tout2); }
                                if (this.stream) {
                                    this.restart = false;
                                    node.stream.removeAllListeners();
                                    this.stream.destroy();
                                }
                                if ((typeof msg.payload === "string") && (msg.payload !== "")) {
                                    st = { track:[msg.payload] };
                                    tags = msg.payload;

                                    this.restart = true;
                                    if ((twitterRateTimeout - Date.now()) > 0 ) {
                                        node.status({fill:"red", shape:"ring", text:tags});
                                        node.tout = setTimeout(function() {
                                            setupStream();
                                        }, twitterRateTimeout - Date.now() );
                                    }
                                    else {
                                        setupStream();
                                    }
                                }
                                else {
                                    node.status({fill:"yellow", shape:"ring", text:RED._("twitter.warn.waiting")});
                                }
                            }
                        });
                    }

                    // wait for input or start the stream
                    if ((this.user === "false") && (tags === '')) {
                        node.status({fill:"yellow", shape:"ring", text:RED._("twitter.warn.waiting")});
                    }
                    else {
                        this.restart = true;
                        setupStream();
                    }
                }
                catch (err) {
                    node.error(err);
                }
            }

            this.on('close', function () {
                if (this.tout) { clearTimeout(this.tout); }
                if (this.tout2) { clearTimeout(this.tout2); }
                if (this.stream) {
                    this.restart = false;
                    this.stream.removeAllListeners();
                    this.stream.destroy();
                }
                if (this.timeout_ids) {
                    for (var i = 0; i < this.timeout_ids.length; i++) {
                        clearTimeout(this.timeout_ids[i]);
                    }
                }
                if (this.poll_ids) {
                    for (var i = 0; i < this.poll_ids.length; i++) {
                        clearInterval(this.poll_ids[i]);
                    }
                }
            });
        } else {
            this.error(RED._("twitter.errors.missingcredentials"));
        }

    }
    
    RED.nodes.registerType("twitter in", TwitterInNode);

    TwitterInNode.prototype.poll = function (interval, url, opts) {
        var node = this;
        var opts = opts || {};
        var pollId;
        opts.count = 1;
        this.twitterConfig.get(url, opts).then(function (result) {
            if (result.status === 429) {
                node.warn("Rate limit hit. Waiting " + Math.floor(result.rateLimitTimeout / 1000) + " seconds to try again");
                node.timeout_ids.push(setTimeout(function () {
                    node.poll(interval, url, opts);
                }, result.rateLimitTimeout))
                return;
            }
            node.debug("Twitter Poll, rateLimitRemaining=" + result.rateLimitRemaining + " rateLimitTimeout=" + Math.floor(result.rateLimitTimeout / 1000) + "s");
            var res = result.body;
            opts.count = 200;
            var since = "0";
            if (res.length > 0) {
                since = res[0].id_str;
            }
            pollId = setInterval(function () {
                opts.since_id = since;
                node.twitterConfig.get(url, opts).then(function (result) {
                    if (result.status === 429) {
                        node.warn("Rate limit hit. Waiting " + Math.floor(result.rateLimitTimeout / 1000) + " seconds to try again");
                        clearInterval(pollId);
                        node.timeout_ids.push(setTimeout(function () {
                            node.poll(interval, url, opts);
                        }, result.rateLimitTimeout))
                        return;
                    }
                    node.debug("Twitter Poll, rateLimitRemaining=" + result.rateLimitRemaining + " rateLimitTimeout=" + Math.floor(result.rateLimitTimeout / 1000) + "s");
                    var res = result.body;
                    if (res.errors) {
                        node.error(res.errors[0].message);
                        if (res.errors[0].code === 44) {
                            // 'since_id parameter is invalid' - reset it for next time
                            delete opts.since_id;
                        }
                        clearInterval(pollId);
                        node.timeout_ids.push(setTimeout(function () {
                            node.poll(interval, url, opts);
                        }, interval))
                        return;
                    }
                    if (res.length > 0) {
                        since = res[0].id_str;
                        var len = res.length;
                        for (var i = len - 1; i >= 0; i--) {
                            var tweet = res[i];
                            if (tweet.user !== undefined) {
                                var where = tweet.user.location;
                                var la = tweet.lang || tweet.user.lang;
                                tweet.text = tweet.text || tweet.full_text;
                                var msg = {
                                    topic: "tweets/" + tweet.user.screen_name,
                                    payload: tweet.text,
                                    lang: la,
                                    tweet: tweet
                                };
                                if (where) {
                                    msg.location = { place: where };
                                    addLocationToTweet(msg);
                                }
                                node.send(msg);
                            }
                        }
                    }
                }).catch(function (err) {
                    node.error(err);
                    clearInterval(pollId);
                    node.timeout_ids.push(setTimeout(function () {
                        delete opts.since_id;
                        delete opts.count;
                        node.poll(interval, url, opts);
                    }, interval))
                })
            }, interval)
            node.poll_ids.push(pollId);
        }).catch(function (err) {
            node.error(err);
            node.timeout_ids.push(setTimeout(function () {
                delete opts.since_id;
                delete opts.count;
                node.poll(interval, url, opts);
            }, interval))
        })
    }

}