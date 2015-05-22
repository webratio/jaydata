$data.Class.define("$data.sqLite.SqLiteTransaction", $data.Transaction, null, {
    abort: function() {
        if (typeof this.transaction.rollBack !== "function") {
            Guard.raise(new Exception("Aborted", "Exception", arguments));
            return;
        }
        this.transaction.rollBack();
    },
    keepAlive: function(yieldInterval, yieldBackoffTime) {
        this.transaction.keepAlive(yieldInterval, yieldBackoffTime);
    },
    yield: function(backoffTime) {
        this.transaction.yield(backoffTime);
    },
    release: function() {
        this.transaction.release();
    },
    retrieveTransaction: function() {
        return this.transaction;
    }
}, null);
