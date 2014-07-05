#!/usr/bin/env node

var request = require('request')
  , Q = require('q')
  
  , URL_BASE = 'https://wwws.mint.com/';

module.exports = Prepare;

/**
 * Public "login" interface. Eg:
 * require('pepper-mint')(user, password)
 * .then(function(mint) {
 *  // do fancy stuff here
 * });
 */
function Prepare(email, password) {
    return Q.Promise(function(resolve, reject) {
        var mint = new PepperMint();
        _login(mint, email, password, function(err) {
            if (err) return reject(err);

            resolve(mint);
        });
    });
}

/** wrap a Promise with JSON body parsing on success */
function _jsonify(promise) {
    return promise.then(function(body) {
        if (~body.indexOf("Session has expired."))
            throw new Error("Session has expired");

        try {
            return JSON.parse(body);
        } catch (e) {
            console.error("Unable to parse", body);
            throw e;
        }
    })
}

/* non-public login util function, so the credentials aren't saved on any object */
function _login(mint, email, password, callback) {
    return mint._get('login.event?task=L')
    .then(function() {
        // then, login
        return mint._form('loginUserSubmit.xevent', {
            username: email
          , password: password
          , task: 'L'
          , browser: 'firefox'
          , browserVersion: '27'
          , os: 'linux'
        });
    })
    .then(function(json) {
        if (json.error && json.error.vError)
            return callback(new Error(json.error.vError.copy));

        if (!(json.sUser && json.sUser.token))
            return callback(new Error("Unable to obtain token"));

        mint.token = json.sUser.token;
        callback(null, mint);
    })
    .fail(function(err) {
        callback(err);
    });
}

/**
 * Main public interface object
 */
function PepperMint() {
    this.requestId = 42; // magic number? random number?

    this.jar = request.jar();
    this.request = request.defaults({jar: this.jar});
}

/**
 * Returns a promise that fetches accoutns
 */
PepperMint.prototype.accounts = function() {
    var self = this;
    return self._jsonForm({
        args: {
            types: [
                "BANK", 
                "CREDIT", 
                "INVESTMENT", 
                "LOAN", 
                "MORTGAGE", 
                "OTHER_PROPERTY", 
                "REAL_ESTATE", 
                "VEHICLE", 
                "UNCLASSIFIED"
            ]
        }, 
        service: "MintAccountService", 
        task: "getAccountsSorted"
    });
};

/**
 * Promised category list fetch
 */
PepperMint.prototype.categories = function() {
    return this._getJsonData('categories');
};

/**
 * Promised tags list fetch
 */
PepperMint.prototype.tags = function() {
    return this._getJsonData('tags');
};



/**
 * Returns a promise that fetches transactions,
 *  optionally filtered by account and offset
 */
PepperMint.prototype.transactions = function(accountId, offset) {
    if (!accountId)
        throw new Error('accountId is required');

    offset = offset || 0;
    return this._getJsonData({
        accountId: accountId
      , offset: offset
      , comparableType: 8 // ?
      , acctChanged: 'T'  // ?
      , task: 'transactions'
    });
};

/**
 * Create a new cash transaction;
 *  to be used to fake transaction imports.
 *
 * NB: There is currently no validation of arguments,
 *  and the server seems to silently reject, too :(
 *
 * Args should look like: {
 *  accountId: 1234 // apparently ignored, but good to have, I guess?
 *  amount: 4.2
 *  category: {
 *      id: id
 *    , name: name
 *  }
 *  date: "MM/DD/YYYY"
 *  isExpense: bool
 *  isInvestment: bool
 *  merchant: "Merchant Name"
 *  note: "Note, if any"
 *  tags: [1234, 5678] // set of ids
 * }
 *
 */
PepperMint.prototype.createTransaction = function(args) {
    var self = this;
    var form = {
        amount: args.amount
      , cashTxnType: 'on'
      , catId: args.category.id
      , category: args.category.name
      , date: args.date
      , isInvestment: args.isInvestment
      , merchant: args.merchant
      , mtAccount: args.accountId
      , mtCashSplitPref: 2              // ?
      , mtCheckNo: ''
      , mtIsExpense: args.isExpense
      , mtType: 'cash'
      , note: args.note
      , task: 'txnadd'
      , txnId: ':0'                     // might be required

      , token: this.token
    };

    // set any tags requested
    if (Array.isArray(args.tags)) {
        args.tags.forEach(function(id) {
            form['tag' + id] = 2; // what? 2?!
        });
    }

    return self._form('updateTransaction.xevent', form);
};



/**
 * Delete a transaction by its id
 */
PepperMint.prototype.deleteTransaction = function(transactionId) {
    return this._form('updateTransaction.xevent', {
        task: 'delete',
        txnId: transactionId,
        token: this.token
    });
};



/*
 * Util methods
 */

PepperMint.prototype._get = function(url, qs) {
    var request = this.request;
    return Q.Promise(function(resolve, reject) {
        var fullUrl = URL_BASE + url;
        var args = {url: fullUrl};
        if (qs)
            args.qs = qs;

        request(args, function(err, response, body) {
            if (err) return reject(err);
            if (200 != response.statusCode)
                return reject(new Error("Failed to load " + fullUrl));

            resolve(body);
        });
    });
};

PepperMint.prototype._getJson = function(url, qs) {
    return _jsonify(this._get(url, qs));
};

/** Shortcut to fetch getJsonData of a single task */
PepperMint.prototype._getJsonData = function(args) {
    if ('string' === typeof(args))
        args = {task: args};
    args.rnd = this._random();

    return this._getJson('getJsonData.xevent', args)
    .then(function(json) {
        return json.set[0].data
    });
};


PepperMint.prototype._form = function(url, form) {
    var request = this.request;
    return _jsonify(Q.Promise(function(resolve, reject) {
        var fullUrl = URL_BASE + url;
        request({
            url: fullUrl
          , method: 'POST'
          , form: form
          , headers: {
                accept: 'application/json'
            }
        }, function(err, response, body) {
            if (err) return reject(err);
            if (response.statusCode > 204) {
                var error = new Error("Failed to load " + fullUrl);
                error.response = response;
                error.body = body;
                return reject(error);
            }

            resolve(body);
        });
    }));
};

PepperMint.prototype._jsonForm = function(json) {
    var reqId = '' + this.requestId++;
    json.id = reqId;
    var url = 'bundledServiceController.xevent?legacy=false&token=' + this.token;

    return this._form(url, {
        input: JSON.stringify([json]) // weird
    }).then(function(resp) {
        if (!resp.response) {
            var task = json.service + "/" + json.task;
            throw new Error("Unable to parse response for " + task);
        }

        return resp.response[reqId].response;
    });
};

PepperMint.prototype._random = function() {
    return new Date().getTime();
};

