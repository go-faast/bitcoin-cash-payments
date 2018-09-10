'use strict'

/* eslint-disable no-console, no-process-env */
/* eslint-env mocha */
/* eslint-disable no-unused-expressions */

const chai = require('chai')
const expect = chai.expect
chai.config.includeStack = true

let xprv = 'xprv9s21ZrQH143K3z2wCDRa3rHg9CHKedM1GvbJzGeZB14tsFdiDtpY6T96c1wWr9rwWhU5C8zcEWFbBVa4T3A8bhGSESDG8Kx1SSPfM2rrjxk'
let xpub44Bch = 'xpub6EX58mQ6azTQ4yrQvnZzxWofBANUD839XV3wVH715Q4PhxA2LYAHrn6h2VcwfH2sKoGS6RY4DNuyzn6AQxKPSaSoB2uQkEP2244JCf4eHA1'
let privateKey = ''
let pubAddress = ''

// If you do this for real, you deserve what is coming to you.
let entropy = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'

let BitcoinCashDepositUtils = require('../index')({
  insightUrl: 'https://bitcoincash.blockexplorer.com/api/',
  network: 'mainnet'
})
describe('Mainnet BitcoinCashDepositUtils', function () {
  it('get an xpub from an xprv', function (done) {
    let generateXpub = BitcoinCashDepositUtils.getXpubFromXprv(xprv)
    expect(generateXpub).to.deep.equal(xpub44Bch)
    done()
  })
  it('getDepositAddress for 0/1', function (done) {
    pubAddress = BitcoinCashDepositUtils.bip44(xpub44Bch, 1)
    // console.log(pubAddress)
    expect(pubAddress).to.equal('qrcz4kes5jtktk66mf0508g49h4fs5f8zstpt3f0jc')
    done()
  })
  it('validate generated address', function (done) {
    let valid = BitcoinCashDepositUtils.validateAddress(pubAddress)
    // console.log(pubAddress)
    expect(valid.valid).to.equal(true)
    done()
  })
  it('fail legacy address', function (done) {
    let valid = BitcoinCashDepositUtils.validateAddress('1NttWjysG8Wuc9GFDVDJcBb73U3XXLTUxC')
    // console.log(pubAddress)
    expect(valid.valid).to.equal(false)
    done()
  })
  it('convert BCH address to legacy style address for 0/1', function (done) {
    let oldAddress = BitcoinCashDepositUtils.standardizeAddress(pubAddress)
    // console.log(pubAddress)
    expect(oldAddress).to.equal('1NttWjysG8Wuc9GFDVDJcBb73U3XXLTUxC')
    done()
  })
  it('getPrivateKey for 0/1', function (done) {
    privateKey = BitcoinCashDepositUtils.getPrivateKey(xprv, 1)
    expect(privateKey).to.equal('KwR3V6oUrxNP4R6GcA2TxMJmS6pt9p2CgjYi9zhpM56RFmowxQYV')
    done()
  })
  it('privateToPublic for 0/1', function (done) {
    let pubKey = BitcoinCashDepositUtils.privateToPublic(privateKey)
    expect(pubKey).to.equal(pubAddress)
    done()
  })
  it('generate a new set of pub and priv keys', function (done) {
    let keys = BitcoinCashDepositUtils.generateNewKeys(entropy)
    expect(keys.xprv).to.equal('xprv9s21ZrQH143K3SPAc8jgfzFS4cFvbZBFCyDauH2pbBWuG2Vs1wvNAu6h6F3jsdakvPMbSdzNT6ESxnykGiQXgst5jkD21d2J5FTEiuLrxzn')
    expect(keys.xpub).to.equal('xpub6DbsLTfbuG6AACFBfi88VgZPv1fTZsKXZ3bBJWtPD1nd8GGwX36TRVmn581KkoWUeT7BmarKsAkCYLWgYMXRqbKXPREzyxJYcb62k3zPaRo')
    let generatedPubAddress = BitcoinCashDepositUtils.bip44(keys.xpub, 66)
    let generatedWIF = BitcoinCashDepositUtils.getPrivateKey(keys.xprv, 66)
    expect(BitcoinCashDepositUtils.privateToPublic(generatedWIF)).to.equal(generatedPubAddress)
    done()
  })

  // This test takes a long time. It really just makes sure we don't have padding
  // issues in a brute force way.
  let regress = false
  if (regress) {
    it('generate 1000 addresses and private keys, make sure they match', function (done) {
      let keys = BitcoinCashDepositUtils.generateNewKeys(entropy)
      let paths = []
      for (let i = 4000; i < 5000; i++) {
        paths.push(i)
      }
      let tasks = []
      paths.forEach(function (path) {
        tasks.push(function (cb) {
          let pub = BitcoinCashDepositUtils.bip44(keys.xpub, path)
          let prv = BitcoinCashDepositUtils.getPrivateKey(keys.xprv, path)
          let pubFromPrv = BitcoinCashDepositUtils.privateToPublic(prv)
          if (pub === pubFromPrv) {
            cb(null, {pub: pub, prv: prv})
          } else {
            cb(new Error('key mismatch', pub, prv, pubFromPrv))
          }
        })
      })
      let async = require('async')
      async.parallel(tasks, function (err, res) {
        expect(err).to.not.exist
        // console.log(res)
        done(err)
      })
    })
  }
  let getUTXOs = true
  let currentUTXO = {}
  let currentSignedTx = {}
  if (getUTXOs) {
    it('Get UTXOs for a single address', function (done) {
      BitcoinCashDepositUtils.getUTXOs(xpub44Bch, 1, function (err, utxos) {
        if (err) console.log(err)
        expect(utxos.length).above(0)
        currentUTXO = utxos
        done()
      })
    })
  }

  it('Generate a sweep transaction for a single address', function (done) {
    let to = BitcoinCashDepositUtils.bip44(xpub44Bch, 1)
    let signedtx = BitcoinCashDepositUtils.getSweepTransaction(xprv, 1, to, currentUTXO)
    // console.log(signedtx)
    // expect(signedtx).to.deep.equal(signedTxExpected)
    expect(signedtx.signedTx).to.exist
    expect(signedtx.txid).to.exist
    currentSignedTx = signedtx
    done()
  })
  let broadcast = true
  if (broadcast) {
    it('Broadcast a sweep transaction for a single address', function (done) {
      BitcoinCashDepositUtils.broadcastTransaction(currentSignedTx, function (err, txHash) {
        if (err) console.log(err)
        // expect(txHash).to.deep.equal(txHashExpected)
        expect(txHash.signedTx).to.exist
        expect(txHash.txid).to.exist
        expect(txHash.broadcasted).to.equal(true)
        done()
      })
    })
  }
  it('Sweep transaction for a single address', function (done) {
    // BitcoinCashDepositUtils.sweepTransaction(xprv, 2, to, function (err, sweptTransaction) {
    //
    // })
    done()
  })
})
