const bch = require('bitcoincashjs')
const bchaddr = require('bchaddrjs')
const request = require('request')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
console.log('SECURITY WARNING: BCH PAYMENTS DEPRECATED - PLEASE UPGRADE TO 0.2.0 - SSL NOT ENFORCED')
const MIN_RELAY_FEE = 1000
const DEFAULT_SAT_PER_BYTE = 1
const CASH_ADDR_FORMAT = bch.Address.CashAddrFormat
function BitcoinCashDepositUtils (options) {
  if (!(this instanceof BitcoinCashDepositUtils)) return new BitcoinCashDepositUtils(options)
  let self = this
  self.options = Object.assign({}, options || {})
  if (!self.options.insightUrl) {
    self.options.insightUrl = 'https://blockdozer.com/insight-api/'
    console.log('WARN: Using default bch block explorer. It is highly suggested you set one yourself!', self.options.insightUrl)
  }

  if (!self.options.feePerKb) {
    self.options.feePerByte = DEFAULT_SAT_PER_BYTE
  }
  if (!self.options.network || (self.options.network === 'mainnet')) {
    self.options.network = bch.Networks.livenet
    if (!self.options.backupBroadcastUrl) {
      self.options.backupBroadcastUrl = 'https://blockdozer.com/insight-api/'
    }
  } else if (self.options.network === 'testnet') {
    self.options.network = bch.Networks.testnet
    if (!self.options.backupBroadcastUrl) {
      self.options.backupBroadcastUrl = 'https://blockdozer.com/insight-api/'
    }
  } else {
    return new Error('Invalid network provided ' + self.options.network)
  }
  // if (!self.options.password) throw new Error('BitcoinCashDepositUtils: password required')
  return self
}

BitcoinCashDepositUtils.prototype.bip44 = function (xpub, path) {
  let self = this
  let node = new bch.HDPublicKey(xpub)
  let child = node.derive('m/0').derive(path)
  let address = new bch.Address(child.publicKey, self.options.network)
  let addrstr = address.toString(CASH_ADDR_FORMAT).split(':')
  if (addrstr.length === 2) {
    return addrstr[1]
  } else {
    return new Error('Unable to derive cash address for ' + address)
  }
}

BitcoinCashDepositUtils.prototype.getPrivateKey = function (xprv, path) {
  let self = this
  if (!xprv) throw new Error('Xprv is null. Bad things will happen to you.')
  let node = new bch.HDPrivateKey(xprv)
  let child = node.derive("m/44'/145'/0'/0").derive(0).derive(path)
  let privateKey = new bch.PrivateKey(child.privateKey, self.options.network)
  return privateKey.toWIF()

// const node = bch.HDNode.fromBase58(xprv, self.options.network)
// let child = node.derivePath("m/44'/0'/0'/0")
// let nodeDerivation = child.derive(0).derive(path)
// return nodeDerivation.keyPair.toWIF()
}

BitcoinCashDepositUtils.prototype.privateToPublic = function (privateKey) {
  let self = this
  let PrivateKey = bch.PrivateKey
  let address = PrivateKey.fromWIF(privateKey).toAddress(self.options.network)
  let addrstr = address.toString(CASH_ADDR_FORMAT).split(':')
  if (addrstr.length === 2) {
    return addrstr[1]
  } else {
    return new Error('Unable to derive cash address for ' + privateKey)
  }
}

// Convert a bitcoincash address to a standard address
BitcoinCashDepositUtils.prototype.standardizeAddress = function (address) {
  return bchaddr.toLegacyAddress(address)
}

// Convert a bitcoincash address to a standard address
BitcoinCashDepositUtils.prototype.validateAddress = function (address) {
  /*
  {
    valid: true,
    error: 'Human readable error message'
  }
  */
  let resp = {
    valid: bchaddr.isCashAddress(address),
    network: 'TBD'
  }
  if (!resp.valid) {
    resp.error = 'Only bitcoin cash style addresses accepted (ex. bitcoincash:qrcz...f0jc)'
  }
  return resp
}

BitcoinCashDepositUtils.prototype.generateNewKeys = function (entropy) {
  let self = this
  var root = bch.HDPrivateKey.fromSeed(entropy, self.options.network)
  return {
    xprv: root.xprivkey,
    xpub: self.getXpubFromXprv(root.xprivkey)
  }
}

BitcoinCashDepositUtils.prototype.getXpubFromXprv = function (xprv) {
  let node = new bch.HDPrivateKey(xprv)
  let child = node.derive("m/44'/145'/0'/0")
  return child.xpubkey
}

BitcoinCashDepositUtils.prototype.getBalance = function (address, done) {
  let self = this
  let url = self.options.insightUrl + 'addr/' + address
  request.get({json: true, url: url}, function (err, response, body) {
    if (!err && response.statusCode !== 200) {
      return done(new Error('Unable to get balance from ' + url))
    } else {
      done(null, {balance: body.balance, unconfirmedBalance: body.unconfirmedBalance})
    }
  })
}

BitcoinCashDepositUtils.prototype.getUTXOs = function (xpub, path, done) {
  let self = this
  let address = self.bip44(xpub, path)
  // console.log('sweeping ', address)
  let url = self.options.insightUrl + 'addr/' + address + '/utxo'
  request.get({json: true, url: url}, function (err, response, body) {
    if (!err && response.statusCode !== 200) {
      return done(new Error('Unable to get UTXOs from ' + url))
    } else {
      let cleanUTXOs = []
      body.forEach(function (utxo) {
        utxo.txId = utxo.txid
        utxo.outputIndex = utxo.vout
        utxo.script = utxo['scriptPubKey']
        utxo.address = self.standardizeAddress(utxo.address)
        delete utxo['confirmations']
        delete utxo['height']
        delete utxo['ts']
        cleanUTXOs.push(utxo)
      })
      if (self.options.network === bch.Networks.testnet) {
        console.log('TESTNET ENABLED: Clipping UTXO length to 2 for test purposes')
        cleanUTXOs = cleanUTXOs.slice(0, 2)
      }
      done(null, cleanUTXOs)
    }
  })
}
BitcoinCashDepositUtils.prototype.getSweepTransaction = function (xprv, path, to, utxo, feePerByte) {
  let self = this
  let transaction = new bch.Transaction()
  let totalBalance = 0
  if (utxo.length === 0) {
    return new Error('no UTXOs')
  }
  utxo.forEach(function (spendable) {
    totalBalance += spendable.satoshis
    transaction.from(spendable)
  })
  if (!feePerByte) feePerByte = self.options.feePerByte
  let txfee = estimateTxFee(feePerByte, utxo.length, 1, true)
  if (txfee < MIN_RELAY_FEE) txfee = MIN_RELAY_FEE
  if ((totalBalance - txfee) < txfee) return new Error('Balance too small to sweep!' + totalBalance + ' ' + txfee)
  to = self.standardizeAddress(to)
  transaction.to(to, totalBalance - txfee)
  transaction.sign(self.getPrivateKey(xprv, path))
  return { signedTx: transaction.toString(), txid: transaction.toObject().hash }
}

BitcoinCashDepositUtils.prototype.broadcastTransaction = function (txObject, done, retryUrl, originalResponse) {
  let self = this
  let textBody = '{"rawtx":"' + txObject.signedTx + '"}'
  const broadcastHeaders = {
    'pragma': 'no-cache',
    'cookie': '__cfduid=d365c2b104e8c0e947ad9991de7515e131528318303',
    'origin': 'https://blockdozer.com/',
    'accept-encoding': 'gzip, deflate, br',
    'accept-language': 'en-US,en;q=0.9,fr;q=0.8,es;q=0.7',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/67.0.3396.99 Safari/537.36',
    'content-type': 'application/json;charset=UTF-8',
    'accept': 'application/json, text/plain, */*',
    'cache-control': 'no-cache',
    'authority': 'blockexplorer.com',
    'referer': 'https://blockdozer.com/tx/send'
  }
  let url
  if (retryUrl) url = retryUrl
  else url = self.options.insightUrl
  var options = {
    url: url + 'tx/send',
    method: 'POST',
    headers: broadcastHeaders,
    body: textBody
  }
  request(options, function (error, response, body) {
    if (!error && response.statusCode === 200) {
      txObject.broadcasted = true
      done(null, txObject)
    } else {
      if (url !== retryUrl) { // First broadcast attempt. Lets try again.
        self.broadcastTransaction(txObject, done, self.options.backupBroadcastUrl, body)
      } else {
        // Second attempt failed
        done(new Error('unable to broadcast. Some debug info: ' + body.toString() + ' ---- ' + originalResponse.toString()))
      }
    }
  })
}

BitcoinCashDepositUtils.prototype.sweepTransaction = function (xpub, xprv, path, to, feePerByte, done) {
  let self = this
  self.getUTXOs(xpub, path, function (err, utxo) {
    if (err) return done(err)
    let signedTx = self.getSweepTransaction(xprv, path, to, utxo, feePerByte)
    self.broadcastTransaction(signedTx, done)
  })
}

/**
 * Estimate size of transaction a certain number of inputs and outputs.
 * This function is based off of ledger-wallet-webtool/src/TransactionUtils.js#estimateTransactionSize
 */
function estimateTxSize (inputsCount, outputsCount, handleSegwit) {
  var maxNoWitness,
    maxSize,
    maxWitness,
    minNoWitness,
    minSize,
    minWitness,
    varintLength
  if (inputsCount < 0xfd) {
    varintLength = 1
  } else if (inputsCount < 0xffff) {
    varintLength = 3
  } else {
    varintLength = 5
  }
  if (handleSegwit) {
    minNoWitness =
      varintLength + 4 + 2 + 59 * inputsCount + 1 + 31 * outputsCount + 4
    maxNoWitness =
      varintLength + 4 + 2 + 59 * inputsCount + 1 + 33 * outputsCount + 4
    minWitness =
      varintLength +
      4 +
      2 +
      59 * inputsCount +
      1 +
      31 * outputsCount +
      4 +
      106 * inputsCount
    maxWitness =
      varintLength +
      4 +
      2 +
      59 * inputsCount +
      1 +
      33 * outputsCount +
      4 +
      108 * inputsCount
    minSize = (minNoWitness * 3 + minWitness) / 4
    maxSize = (maxNoWitness * 3 + maxWitness) / 4
  } else {
    minSize = varintLength + 4 + 146 * inputsCount + 1 + 31 * outputsCount + 4
    maxSize = varintLength + 4 + 148 * inputsCount + 1 + 33 * outputsCount + 4
  }
  return {
    min: minSize,
    max: maxSize
  }
}

function estimateTxFee (satPerByte, inputsCount, outputsCount, handleSegwit) {
  const { min, max } = estimateTxSize(inputsCount, outputsCount, handleSegwit)
  const mean = Math.ceil((min + max) / 2)
  return mean * satPerByte
}

module.exports = BitcoinCashDepositUtils
