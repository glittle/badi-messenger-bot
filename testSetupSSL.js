'use strict';

require('letsencrypt-express').create({

  //server: 'https://acme-v01.api.letsencrypt.org/directory'
  server: 'staging'

  , email: 'glen.little@gmail.com'

  , agreeTos: true

  , approveDomains: ['wondrous-badi.ga', 'www.wondrous-badi.ga']

  , app: require('express')().use('/', function (req, res) {
    res.end('Hello, World!');
  })

}).listen(80, 443);