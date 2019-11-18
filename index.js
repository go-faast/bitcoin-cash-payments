const bch = require('bitcoincashjs')
const bchaddr = require('bchaddrjs')
const request = require('request')
const MIN_RELAY_FEE = 1000
const DEFAULT_SAT_PER_BYTE = 1
const CASH_ADDR_FORMAT = bch.Address.CashAddrFormat
function BitcoinCashDepositUtils (options) {
  if (!(this instanceof BitcoinCashDepositUtils)) return new BitcoinCashDepositUtils(options)
  const self = this
  self.options = Object.assign({}, options || {})
  if (!self.options.insightUrl) {
    self.options.insightUrl = 'https://bch2.trezor.io/'
    console.log('WARN: Using default bch block explorer. It is highly suggested you set one yourself!', self.options.insightUrl)
  }

  if (!self.options.feePerKb) {
    self.options.feePerByte = DEFAULT_SAT_PER_BYTE
  }
  if (!self.options.network || (self.options.network === 'mainnet')) {
    self.options.network = bch.Networks.livenet
    if (!self.options.backupBroadcastUrl) {
      self.options.backupBroadcastUrl = 'https://bch2.trezor.io/'
    }
  } else if (self.options.network === 'testnet') {
    self.options.network = bch.Networks.testnet
    if (!self.options.backupBroadcastUrl) {
      self.options.backupBroadcastUrl = 'https://bch2.trezor.io/'
    }
  } else {
    return new Error('Invalid network provided ' + self.options.network)
  }
  // if (!self.options.password) throw new Error('BitcoinCashDepositUtils: password required')
  return self
}

BitcoinCashDepositUtils.prototype.bip44 = function (xpub, path) {
  const self = this
  const node = new bch.HDPublicKey(xpub)
  const child = node.derive('m/0').derive(path)
  const address = new bch.Address(child.publicKey, self.options.network)
  const addrstr = address.toString(CASH_ADDR_FORMAT).split(':')
  if (addrstr.length === 2) {
    return addrstr[1]
  } else {
    return new Error('Unable to derive cash address for ' + address)
  }
}

BitcoinCashDepositUtils.prototype.getPrivateKey = function (xprv, path) {
  const self = this
  if (!xprv) throw new Error('Xprv is null. Bad things will happen to you.')
  const node = new bch.HDPrivateKey(xprv)
  const child = node.derive("m/44'/145'/0'/0").derive(0).derive(path)
  const privateKey = new bch.PrivateKey(child.privateKey, self.options.network)
  return privateKey.toWIF()

// const node = bch.HDNode.fromBase58(xprv, self.options.network)
// let child = node.derivePath("m/44'/0'/0'/0")
// let nodeDerivation = child.derive(0).derive(path)
// return nodeDerivation.keyPair.toWIF()
}

BitcoinCashDepositUtils.prototype.privateToPublic = function (privateKey) {
  const self = this
  const PrivateKey = bch.PrivateKey
  const address = PrivateKey.fromWIF(privateKey).toAddress(self.options.network)
  const addrstr = address.toString(CASH_ADDR_FORMAT).split(':')
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
  const resp = {
    valid: bchaddr.isCashAddress(address),
    network: 'TBD'
  }
  if (!resp.valid) {
    resp.error = 'Only bitcoin cash style addresses accepted (ex. bitcoincash:qrcz...f0jc)'
  }
  return resp
}

BitcoinCashDepositUtils.prototype.generateNewKeys = function (entropy) {
  const self = this
  var root = bch.HDPrivateKey.fromSeed(entropy, self.options.network)
  return {
    xprv: root.xprivkey,
    xpub: self.getXpubFromXprv(root.xprivkey)
  }
}

BitcoinCashDepositUtils.prototype.getXpubFromXprv = function (xprv) {
  const node = new bch.HDPrivateKey(xprv)
  const child = node.derive("m/44'/145'/0'/0")
  return child.xpubkey
}

BitcoinCashDepositUtils.prototype.getBalance = function (address, done) {
  const self = this
  const url = self.options.insightUrl + 'api/v1/address/' + address
  request.get({ json: true, url: url }, function (err, response, body) {
    if (!err && response.statusCode !== 200) {
      return done(new Error('Unable to get balance from ' + url))
    } else {
      let balance, unconfirmedBalance
      try {
        balance = Number.parseFloat(body.balance)
        unconfirmedBalance = Number.parseFloat(body.unconfirmedBalance)
      } catch (error) {
        return done(new Error('Unable to parse balance to number'))
      }
      return done(null, { balance: balance, unconfirmedBalance: unconfirmedBalance })
    }
  })
}

BitcoinCashDepositUtils.prototype.getUTXOs = function (xpub, path, done) {
  const self = this
  const address = self.bip44(xpub, path)
  // console.log('sweeping ', address)
  const scriptPubKey = bch.Script.fromAddress(self.standardizeAddress(address)).toHex()
  const url = self.options.insightUrl + 'api/v1/utxo/' + self.standardizeAddress(address)
  request.get({ json: true, url: url }, function (err, response, body) {
    if (!err && response.statusCode !== 200) {
      return done(new Error('Unable to get UTXOs from ' + url))
    } else {
      let cleanUTXOs = []
      body.forEach(function (utxo) {
        utxo.txId = utxo.txid
        utxo.outputIndex = utxo.vout
        utxo.script = scriptPubKey // TODO: Convert address to script!
        utxo.address = self.standardizeAddress(address)
        delete utxo.confirmations
        delete utxo.height
        cleanUTXOs.push(utxo)
      })
      if (self.options.network === bch.Networks.testnet) {
        console.log('TEST ENABLED: Clipping UTXO length to 2 for test purposes')
        cleanUTXOs = cleanUTXOs.slice(0, 2)
      }
      done(null, cleanUTXOs)
    }
  })
}
BitcoinCashDepositUtils.prototype.getSweepTransaction = function (xprv, path, to, utxo, feePerByte) {
  const self = this
  const transaction = new bch.Transaction()
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
  const self = this
  const textBody = txObject.signedTx
  var options = {
    url: self.options.insightUrl + 'api/v1/sendtx/' + textBody,
    method: 'GET',
    json: true
  }
  request(options, function (error, response, body) {
    if (error) {
      console.log(error)
      return done(new Error('Unable to broadcast', error))
    } else if (!body) {
      return done(new Error('Unable to broadcast, no response'))
    } else {
      if (body.error) {
        return done(new Error('Unable to broadcast, error:', body.error))
      } else {
        if (body.result) {
          txObject.broadcasted = true
          done(null, txObject)
        } else {
          return done(new Error('Unable to broadcast, error:', body))
        }
      }
    }
  })
}

BitcoinCashDepositUtils.prototype.sweepTransaction = function (xpub, xprv, path, to, feePerByte, done) {
  const self = this
  self.getUTXOs(xpub, path, function (err, utxo) {
    if (err) return done(err)
    const signedTx = self.getSweepTransaction(xprv, path, to, utxo, feePerByte)
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
