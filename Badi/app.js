'use strict'
const http = require('http')
const Bot = require('messenger-bot');
const storage = require('node-persist');
const getDate = require('./badiCalc');

let bot = new Bot({
  token: 'EAASZCBdZBZCAw4BAENLsG9yFr82PVd5A9nAoWqvMZAxD1OZCpVkDUGCgU1jI51fEon5qbZASaFpSRgG7IQqZC207K5ucZAFXqZCzLivhE6euolx7yG8lUIW9FblgtvGzArutftE2b2ZC5sHhYZB7tlEEBiaYQTHjgRnfaZBBJBl09kGG8wZDZD',
  verify: 'MyBadiBot'
})

bot.on('error', (err) => {
  console.log(err.message)
})

storage.initSync({
  dir: '../../../../BadiBotStorage'
});


bot.on('message', (payload, reply) => {

  var senderId = payload.sender.id;
  var key = {
    profile: 'profile_' + senderId,
    log: 'profile_' + senderId + '_log'
  };
  
  var profile = storage.getItem(key.profile);
  var log = storage.getItem(key.log);

  if (profile) {
    console.log('Incoming (' + profile.visitCount + '): ' + payload.message.text);
    respond(reply, profile, log, payload.message.text, key);
  } else {
    bot.getProfile(payload.sender.id, (err, profile) => {
      if (err) throw err
      console.log('Incoming (new):' + payload.message.text);
      respond(reply, profile, log, payload.message.text, key);
    });
  }
});

function respond(reply, profile, log, question, key) {

  var answer = [];

  if (question.search(/hello/i) !== -1) {
    answer.push(`Hello ${profile.first_name}!`);
  }

  if (question.search(/today/i) !== -1) {
      var tz = profile.timezone;


    var dateInfo = getDate({ gDate: new Date() }, function (err, info) {
      if (err) {
        answer.push(err);
      } else {
        answer.push(info.text);
      }
    });
  }

  if (answer.length) {
    var answerText = answer.join('\n');
    reply({ text: answerText }, (err) => {
      if (err) throw err
      console.log(`Answered: ${answerText}`)
    })
  } else {
    console.log(`??`)
    reply({ text: 'You can ask "today" and I can tell you what day it is now.' }, (err) => {
        if (err) {
            console.log(err);
        }
    });
    if (log && log.length) {
        reply({ text: `We have chatted ${log.length} times!` }, (err) => {
            if (err) {
                console.log(err);
            }
        });

    }
  }


  if (!log) log = [];
  log.push({
    when: new Date(),
    question: question,
    answer: answer
  });
  profile.visitCount = log.length;

  storage.setItem(key.profile, profile);
  storage.setItem(key.log, log);

  //setTimeout(function () {
  //  text = 'Are you still there??';
  //  reply({ text }, (err) => {
  //    if (err) throw err

  //    console.log(`Sent reminder to ${profile.first_name} ${profile.last_name}: ${text}`)
  //  })

  //}, 10000);
}


http.createServer(bot.middleware()).listen(1844);
