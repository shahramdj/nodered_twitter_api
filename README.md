node-red-node-twitter-API V2.0-public tweets
=====================

<a href="http://nodered.org" target="_new">Node-RED</a> nodes to talk to Twitter.

This is a single node that gets public tweets through Twitter API V 2.0. The Twitter API will **NOT** deliver 100% of all tweets. This does **NOT** give access to the Twitter Firehose.

Install
-------
Download the files and copy them into your "node-red-node-twitter" folder. Node-RED user directory - typically `~/.node-red`. Remember that you need to overwrite the existing files in the "node-red-node-twitter" folder. 

Usage
-----

Provides one node to receive public tweets.

### Input

Twitter input node. Can be used to search:

 - all tweets by given keyword

When returning events it sets the `msg.payload` to the twitter text.

**Note**: This node is not connected to the FireHose, so will not return 100% of all tweets to a busy @id or #hashtag.

**Note**: when set to a specific user's tweets, or your direct messages, the node is subject to
Twitter's API rate limiting. If you deploy the flows multiple times within a 15 minute window, you may
exceed the limit and will see errors from the node. These errors will clear when the current 15 minute window
passes.

