(function() {
    var GLOBAL = this;
    
    if (!!GLOBAL.cordova && GLOBAL.navigator.userAgent.indexOf("Windows Phone ") >= 0) {
        GLOBAL.document.addEventListener("deviceready", installWrapper);
    } else {
        installWrapper();
    }
    
    function installWrapper() {
        var _openDatabase = GLOBAL.openDatabase;
        
        var dbContexts = {};
        
        function retrieveDbContext(dbName) {
            var dbContext = dbContexts[dbName];
            if (!dbContext) {
                dbContext = {
                    requestedTxs: 0
                };
                dbContexts[dbName] = dbContext;
            }
            return dbContext;
        }
        
        function createContext(dbContext, realTxFactory, canYield) {
            return {
                dbContext: dbContext,
                realTxFactory: realTxFactory,
                canYield: canYield,
                realTx: null,
                callbackDepth: 0,
                activeQueries: 0,
                queuedQueries: [],
                pollerRunning: false,
                keepAlive: false,
                yieldTimer: null,
                yielding: false
            };
        };
        
        function openDatabase(dbName) {
            var db = _openDatabase.apply(this, arguments);
            
            var dbContext = retrieveDbContext(dbName);
            
            var _transactionFactory = db.transaction.bind(db);
            db.transaction = function(txCallback, errorCallback, successCallback) {
                var context = createContext(dbContext, _transactionFactory, true);
                return constructTransaction(context, txCallback, errorCallback, successCallback);
            };
            
            var _readTransactionFactory = db.readTransaction.bind(db);
            db.readTransaction = function(txCallback, errorCallback, successCallback) {
                var context = createContext(dbContext, _readTransactionFactory, false);
                return constructTransaction(context, txCallback, errorCallback, successCallback);
            };
            
            return db;
        }
        
        function constructTransaction(context, txCallback, errorCallback, successCallback) {
            var dbContext = context.dbContext;
            
            var requestPending = true;
            dbContext.requestedTxs++;
            
            function handleFinishedCreation() {
                if (!requestPending) {
                    return;
                }
                requestPending = false;
                dbContext.requestedTxs--;
            }
            
            return context.realTxFactory(function(tx) {
                handleFinishedCreation();
                context.realTx = tx;
                context.callbackDepth++;
                try {
                    return txCallback.call(this, wrapTx(context));
                } finally {
                    context.callbackDepth--;
                    handleCallbackTermination(context);
                }
            }, function() {
                handleFinishedCreation();
                if (errorCallback) {
                    return errorCallback.apply(this, arguments);
                }           
            }, successCallback);
        }
        
        function wrapTx(context, dontQueue) {
            return {
                executeSql: function(sql, args, callback, errorCallback) {
                    var tx = context.realTx;
                    
                    if (!tx || context.keepAlive && context.callbackDepth <= 0 && !dontQueue) {
                        //console.log("Queuing invalid query", sql);
                        context.queuedQueries.push([sql, args, callback, errorCallback]);
                        return;
                    }
                    
                    context.activeQueries++;
                    return tx.executeSql(sql, args, function(innerTx, resultSet) {
                        context.activeQueries--;
                        try {
                            if (callback) {
                                context.callbackDepth++;
                                try {
                                    return callback.call(this, wrapTx(context), resultSet);
                                } finally {
                                    context.callbackDepth--;
                                }
                            }
                        } finally {
                            handleCallbackTermination(context);
                        }
                    }, function(innerTx, error) {
                        context.activeQueries--;
                        try {
                            if (errorCallback) {
                                context.callbackDepth++;
                                try {
                                    return errorCallback.call(this, wrapTx(context), error);
                                } finally {
                                    context.callbackDepth--;
                                }
                            }
                        } finally {
                            handleCallbackTermination(context);
                        }
                    });
                },
                
                keepAlive: function(yieldInterval, yieldBackoffTime) {
                    if (context.callbackDepth <= 0) {
                        //console.error("Keep alive called too late");
                        throw new Error("Keep alive called too late");
                    }
                    
                    yieldInterval = yieldInterval || 0;
                    yieldBackoffTime = yieldBackoffTime || 0;
                    
                    context.keepAlive = true;
                    if (context.yieldTimer) {
                        window.clearInterval(context.yieldTimer);
                    }
                    if (yieldInterval > 0) {
                        context.yieldTimer = window.setInterval(doYield.bind(this, context, yieldBackoffTime), yieldInterval);
                    } else {
                        context.yieldTimer = null;
                    }
                },
                
                yield: function(backoffTime) {
                    doYield(context, backoffTime);
                },
                
                release: function() {
                    context.keepAlive = false;
                    if (context.yieldTimer) {
                        window.clearInterval(context.yieldTimer);
                    }
                    context.yieldTimer = null;
                    stopPoller(context);
                }
            };
        }
        
        function doYield(context, backoffTime) {
            var dbContext = context.dbContext;
            if (context.yielding || (!context.canYield || dbContext.requestedTxs <= 0)) {
                //console.log("Yield not necessary");
                return;
            }
            
            //console.log("Yielding, others", dbContext.requestedTxs, "backing off for", backoffTime);
            context.realTx = null;
            context.yielding = true;
            stopPoller(context);
            window.setTimeout(function() {
                constructTransaction(context, function() {
                    //console.log("Returned after yielding");
                    context.yielding = false;
                });
            }, backoffTime || 0);
        }
        
        function handleCallbackTermination(context) {
            var tx = context.realTx;
            if (tx && context.keepAlive && context.callbackDepth <= 0 && context.activeQueries <= 0) {
                startPoller(context);
            } else {
                stopPoller(context);
            }
        }
        
        function startPoller(context) {
            if (context.pollerRunning) {
                return;
            }
            context.pollerRunning = true;
            //console.log("Poller started");
            executePoller(context);
        }
        
        function stopPoller(context) {
            context.pollerRunning = false;
        }
        
        function executePoller(context) {
            var tx = context.realTx;
            if (!context.pollerRunning) {
                //console.log("Poller stopped");
                return;
            }
            tx.executeSql("SELECT '$polling'", [], function(innerTx, resultSet) {
                context.callbackDepth++;
                try {
                    executeQueuedQueries(context);
                } finally {
                    context.callbackDepth--;
                    handleCallbackTermination(context);
                }
                executePoller(context); // recurse async
            }, function(innerTx, error) {
                console.error("Poller failed");
            });
        }
        
        function executeQueuedQueries(context) {
            if (context.queuedQueries.length <= 0) {
                return;
            }
            var queries = context.queuedQueries;
            context.queuedQueries = [];
            
            //console.log("Running " + queries.length + " queued queries from poller");
            var tx = wrapTx(context, true);
            for (var i = 0; i < queries.length; i++) {
                tx.executeSql.apply(tx, queries[i]);
            }
        }
        
        GLOBAL.openDatabase = openDatabase;
    }
})();
