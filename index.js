const bch = require('bitcoincashjs')
const bchaddr = require('bchaddrjs')
const request = require('request')
const async = require('async')
const MIN_RELAY_FEE = 1000
const DEFAULT_SAT_PER_BYTE = 1
const CASH_ADDR_FORMAT = bch.Address.CashAddrFormat
function BitcoinCashDepositUtils (options) {
  if (!(this instanceof BitcoinCashDepositUtils)) return new BitcoinCashDepositUtils(options)
  let self = this
  self.options = Object.assign({}, options || {})
  if (self.options.insightUrl) {
    console.log('WARN: INISIGHT URLs no longer used! Please update to Blockbook URL!')
  }
  if (!self.options.blockbookUrls) {
    self.options.blockbookUrls = [
      'https://bch1.trezor.io/',
      'https://bch2.trezor.io/',
      'https://bch3.trezor.io/',
      'https://bch4.trezor.io/']
    console.log('WARN: Using default bch blockbook explorer. It is highly suggested you set one yourself!', self.options.blockbookUrls)
  }

  if (!self.options.feePerKb) {
    self.options.feePerByte = DEFAULT_SAT_PER_BYTE
  }
  if (!self.options.network || (self.options.network === 'mainnet')) {
    self.options.network = bch.Networks.livenet
  } else if (self.options.network === 'testnet') {
    self.options.network = bch.Networks.testnet
  } else {
    return new Error('Invalid network provided ' + self.options.network)
  }
  return self
}

/* Client Permitted */
BitcoinCashDepositUtils.prototype.bip44 = function (xpub, path) {
  let self = this
  let node = new bch.HDPublicKey(xpub)
  let child = node.derive('m/0').derive(path)
  let address = new bch.Address(child.publicKey, self.options.network)
  return address.toString(CASH_ADDR_FORMAT)
}

/* Client Permitted */
BitcoinCashDepositUtils.prototype.getPrivateKey = function (xprv, path) {
  let self = this
  if (!xprv) throw new Error('Xprv is null. Bad things will happen to you.')
  let node = new bch.HDPrivateKey(xprv)
  let child = node.derive("m/44'/145'/0'/0").derive(0).derive(path)
  let privateKey = new bch.PrivateKey(child.privateKey, self.options.network)
  return privateKey.toWIF()
}

/* Client Permitted */
BitcoinCashDepositUtils.prototype.privateToPublic = function (privateKey) {
  let self = this
  let PrivateKey = bch.PrivateKey
  let address = PrivateKey.fromWIF(privateKey).toAddress(self.options.network)
  return address.toString(CASH_ADDR_FORMAT)
}

/* Client Permitted */
// Convert a bitcoincash address to a standard address
BitcoinCashDepositUtils.prototype.standardizeAddress = function (address) {
  return standardizeAddress(address)
}

function standardizeAddress (address) {
  return bchaddr.toLegacyAddress(address)
}

/* Client Permitted */
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

/* Client Permitted */
BitcoinCashDepositUtils.prototype.generateNewKeys = function (entropy) {
  let self = this
  var root = bch.HDPrivateKey.fromSeed(entropy, self.options.network)
  return {
    xprv: root.xprivkey,
    xpub: self.getXpubFromXprv(root.xprivkey)
  }
}

/* Client Permitted */
BitcoinCashDepositUtils.prototype.getXpubFromXprv = function (xprv) {
  let node = new bch.HDPrivateKey(xprv)
  let child = node.derive("m/44'/145'/0'/0")
  return child.xpubkey
}

/* WARN: Remote request - Don't run on light client. */
BitcoinCashDepositUtils.prototype.getBalance = function (address, done) {
  let self = this
  let url = selectRandomURL(self) + 'api/address/' + address
  request.get({json: true, url: url}, function (err, response, body) {
    if (!err && response.statusCode !== 200) {
      return done(new Error('Unable to get balance from ' + url))
    } else {
      let balance
      let unconfirmedBalance
      let netBalance
      try {
        balance = parseFloat(body.balance)
        unconfirmedBalance = parseFloat(body.unconfirmedBalance)
        netBalance = round8(balance + unconfirmedBalance)
      } catch (e) {
        return done(new Error('Unable to get balance from blockbook'))
      }
      done(null, {balance: balance, unconfirmedBalance: unconfirmedBalance, netBalance: netBalance})
    }
  })
}

function round8 (num) { return Math.round(num * 1e8) / 1e8 }

/* WARN: Remote request - Don't run on light client. */
BitcoinCashDepositUtils.prototype.getUTXOs = function (xpub, path, done) {
  let self = this
  let address = self.bip44(xpub, path)
  return self.getAddressUTXOs(address, done)
}

/* WARN: Remote request - Don't run on light client. */
// We only look at the first 1000 transactions. This is a pretty expensive
// query for busy addresses. Sorry Slush!
BitcoinCashDepositUtils.prototype.getAddressUTXOs = function (address, done) {
  let self = this
  let url = selectRandomURL(self) + 'api/address/' + address

  // 1. Get the Transaction history.
  request.get({json: true, url: url}, function (err, response, body) {
    if (!err && response.statusCode !== 200) {
      return done(new Error('Unable to get UTXOs from ' + url))
    } else {
      let asyncTasks = []

      // 2. For each transaction in the history, get the transaction
      body.transactions.forEach(function (txid) {
        asyncTasks.push(function (cb) {
          let url = selectRandomURL(self) + 'api/tx/' + txid
          request.get({json: true, url: url}, function (err, response, body) {
            let txUTXOs = {}
            let spentUnconfirmed = {}
            if (!err && response.statusCode !== 200) {
              return cb(new Error('Unable to get UTXOs from ' + url))
            } else {
              // 3. Loop through the outputs of each transaction
              if (body && body.vout && body.vout.length > 0) {
                txUTXOs = getOutputsFromTransaction(body, address)
                if (body.confirmations === 0) {
                  // We should keep track of any inputs that may be spent, but unconfirmed.
                  spentUnconfirmed = getSpentUTXOsFromTransaction(body)
                }
              }
            }
            cb(null, {txUTXOs, spentUnconfirmed})
          })
        })
      })
      async.parallel(asyncTasks, function (err, results) {
        if (err) {
          return done(new Error('Unable to get UTXOs ' + err))
        } else {
          let cleanUTXOs = {}
          let spentUTXOs = {}
          // 5. Remove unconfirmed spent inputs
          results.forEach(function (txResult) {
            Object.assign(cleanUTXOs, txResult.txUTXOs)
            Object.assign(spentUTXOs, txResult.spentUnconfirmed)
          })
          // 6. Concatenate all found unspents
          let unspentList = Object.keys(cleanUTXOs)
            .filter((key) => !spentUTXOs[key])
            .map((unspent) => cleanUTXOs[unspent])

          if (self.options.network === bch.Networks.testnet) {
            console.log('TESTNET ENABLED: Clipping UTXO length to 2 for test purposes')
            unspentList = unspentList.slice(0, 2)
          }
          done(null, unspentList)
        }
      })
    }
  })
}
/* Example body
{
  'txid': '2a9f1c86b74e7efaabcfae4c8c694e87d5ab45c483a75232e86fc4951e22ee94',
  'version': 1,
  'vin': [
    {
      'txid': '2a845e04a2ad0cc3ba137c53100d313b13a19880e81f92a9766db6ee3aaa013a',
      'vout': 1,
      'sequence': 4294967295,
      'n': 0,
      'scriptSig': {
        'hex': '483045022100ac27a0908cf45299bb1ca6453016ed8e6358a3a974873749f7f45eaa82126b11022070928fc0e4813b6dd5899410f26f41c127214ce9bd6c482f8332d19f5a2cfc22412103bfcf2a935cbde4b67ea1ca1e9db98401965fa361f97c4d14a8b1ec77bbdd62db'
      },
      'addresses': [
        'bitcoincash:qrcz4kes5jtktk66mf0508g49h4fs5f8zstpt3f0jc'
      ],
      'value': '0.02779757'
    }
  ],
  'vout': [
    {
      'value': '0.02778757',
      'n': 0,
      'scriptPubKey': {
        'hex': '76a914f02adb30a49765db5ada5f479d152dea9851271488ac',
        'addresses': [
          'bitcoincash:qrcz4kes5jtktk66mf0508g49h4fs5f8zstpt3f0jc'
        ]
      },
      'spent': false
    }
  ],
  'blockheight': 0,
  'confirmations': 0,
  'blocktime': 0,
  'valueOut': '0.02778757',
  'valueIn': '0.02779757',
  'fees': '0.00001',
  'hex': '01000000013a01aa3aeeb66d76a9921fe88098a1133b310d10537c13bac30cada2045e842a010000006b483045022100ac27a0908cf45299bb1ca6453016ed8e6358a3a974873749f7f45eaa82126b11022070928fc0e4813b6dd5899410f26f41c127214ce9bd6c482f8332d19f5a2cfc22412103bfcf2a935cbde4b67ea1ca1e9db98401965fa361f97c4d14a8b1ec77bbdd62dbffffffff0185662a00000000001976a914f02adb30a49765db5ada5f479d152dea9851271488ac00000000'
}
*/
function getOutputsFromTransaction (body, address) {
  let txUTXOs = {}
  body.vout.forEach(function (vout) {
    // 4. Is the output unspent and to the current address?
    if (vout.spent === false && vout.scriptPubKey.addresses[0] === address) {
      txUTXOs[body.txid + '-' + vout.n] = {
        txId: body.txid,
        outputIndex: vout.n,
        script: vout.scriptPubKey.hex,
        address: standardizeAddress(address),
        amount: parseFloat(vout.value),
        satoshis: valueToSatoshis(vout.value)
      }
    }
  })
  return txUTXOs
}

function getSpentUTXOsFromTransaction (body) {
  let spentUnconfirmed = {}
  body.vin.forEach(function (vin) {
    spentUnconfirmed[vin.txid + '-' + vin.vout] = {
      txid: vin.txid,
      voud: vin.vout
    }
  })
  return spentUnconfirmed
}

function valueToSatoshis (value) {
  value = parseFloat(value)
  return Number(value * 1e8)
}

function selectRandomURL (self) {
  return self.options.blockbookUrls[randomIntFromInterval(0, self.options.blockbookUrls.length - 1)]
}

function randomIntFromInterval (min, max) { // min and max included
  return Math.floor(Math.random() * (max - min + 1) + min)
}

/* WARN: Remote request - Don't run on light client. */
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

/* WARN: Remote request - Don't run on light client. */
BitcoinCashDepositUtils.prototype.broadcastTransaction = function (txObject, done) {
  let self = this
  let textBody = txObject.signedTx
  let url = selectRandomURL(self) + 'api/sendtx/'
  var options = {
    url: url,
    method: 'POST',
    body: textBody
  }
  request(options, function (error, response, body) {
    if (!error && response.statusCode === 200) {
      txObject.broadcasted = true
      done(null, txObject)
    } else {
      return done(new Error('Broadcast error: ' + response.statusCode + ' ' + url + ' ' + body + '' + error))
    }
  })
}

/* WARN: Remote request - Don't run on light client. */
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
