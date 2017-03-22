let express = require('express');
const bot = require('./badiBot').bot;

let app = express();
app.set('port', (process.env.PORT || 8002));

app.get('/', (req, res) => {
  return 'hello';
  // return bot._verify(req, res)
})

app.post('/', (req, res) => {
  console.log('\nincoming post');

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


// Start the server
let server = app.listen(app.get('port'), function () {
  console.log('App listening on port %s at %s', server.address().port, new Date());
  console.log('Press Ctrl+C to quit.');
});