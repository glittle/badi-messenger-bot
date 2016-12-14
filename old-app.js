'use strict';
const http = require('http');
const https = require('https');
const request = require('request');



//-----
// returns an instance of node-letsencrypt with additional helper methods
var lex = require('letsencrypt-express').create({
  // set to https://acme-v01.api.letsencrypt.org/directory in production
  //server: 'staging'
  server: 'https://acme-v01.api.letsencrypt.org/directory'

  // If you wish to replace the default plugins, you may do so here
  //
  ,
  challenges: {
    'http-01': require('le-challenge-fs').create({
      webrootPath: '/tmp/acme-challenges'
    })
  },
  store: require('le-store-certbot').create({
    webrootPath: '/tmp/acme-challenges'
  }),

  approveDomains: approveDomains
});

function approveDomains(opts, certs, cb) {
  // This is where you check your database and associated
  // email addresses with domains and agreements and such


  // The domains being approved for the first time are listed in opts.domains
  // Certs being renewed are listed in certs.altnames
  if (certs) {
    opts.domains = certs.altnames;
  } else {
    opts.email = 'glen.little@gmail.com';
    opts.agreeTos = true;
  }

  // NOTE: you can also change other options such as `challengeType` and `challenge`
  // opts.challengeType = 'http-01';
  // opts.challenge = require('le-challenge-fs').create({});

  cb(null, {
    options: opts,
    certs: certs
  });
}

var app = require('express')();



app.use('/gAction', function (req, res) {
  var backendUrl = 'http://localhost:8001' + req.url;
  // req.pipe(request({ qs:req.query, uri: url })).pipe(res);
  console.log('\ngAction ' + req.url);

  req.pipe(request({
    url: backendUrl,
    qs: req.query,
    method: req.method
  }, function (error, response, body) {
    if (error) {
      if (error.code === 'ECONNREFUSED') {
        console.error('Refused connection');
      } else {
        console.error(error)
      }
    }
  })).pipe(res);

});

app.use('/fbBot2', function (req, res) {
  var backendUrl = 'http://localhost:8002' + req.url;
  // req.pipe(request({ qs:req.query, uri: url })).pipe(res);
  console.log('\nfbBot2 ' + req.url);

  req.pipe(request({
    url: backendUrl,
    qs: req.query,
    method: req.method
  }, function (error, response, body) {
    if (error) {
      if (error.code === 'ECONNREFUSED') {
        console.error('Refused connection');
      } else {
        console.error(error)
      }
    }
  })).pipe(res);

});


app.get('/fbBot1', (req, res) => {
  return bot._verify(req, res)
})

app.post('/fbBot1', (req, res) => {
  console.log('incoming post');

  res.writeHead(200, {
    'Content-Type': 'application/json'
  })
  let body = ''

  req.on('data', (chunk) => {
    body += chunk
  })

  req.on('end', () => {
    let parsed = JSON.parse(body)
    bot._handleMessage(parsed)

    res.end(JSON.stringify({
      status: 'ok'
    }))
  })
})

app.get('/', function (req, res) {
  res.end('Hello, World!');
});

app.get('/abc', function (req, res) {
  res.end('Hello, ABC 123!');
});

app.get('/app1', function (req, res) {
  console.log(`\nsending app file to ${req.connection.remoteAddress}`);
  var options = {
    headers: {
      'Content-disposition': 'attachment; filename=Wondrous-Badi-App.apk'
    }
  };
  res.sendFile('C:\\Users\\glen\\Source\\Projects\\WondrousBadiMobile\\WondrousBadi\\bin\\Android\\Release\\android-release.apk',
    options);
});


// handles acme-challenge and redirects to https
require('http').createServer(lex.middleware(require('redirect-https')())).listen(80, function () {
  // console.log("\nListening for ACME http-01 challenges on", this.address());
});

// handles your app
require('https').createServer(lex.httpsOptions, lex.middleware(app)).listen(443, function () {
  // console.log("Listening for ACME tls-sni-01 challenges and serve app on", this.address());
  console.log("\n\nListening on", this.address());
});

const bot = require('./badiBot').bot;