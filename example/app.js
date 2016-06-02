'use strict'
const http = require('http')
const Bot = require('messenger-bot')
const getDate = require('./badiCalc')

let bot = new Bot({
  token: 'EAASZCBdZBZCAw4BAENLsG9yFr82PVd5A9nAoWqvMZAxD1OZCpVkDUGCgU1jI51fEon5qbZASaFpSRgG7IQqZC207K5ucZAFXqZCzLivhE6euolx7yG8lUIW9FblgtvGzArutftE2b2ZC5sHhYZB7tlEEBiaYQTHjgRnfaZBBJBl09kGG8wZDZD',
  verify: 'MyBadiBot'
})

bot.on('error', (err) => {
  console.log(err.message)
})


var knownPeople = {};

bot.on('message', (payload, reply) => {
  console.log('incoming...');
  var senderId = payload.sender.id;
  var profile = knownPeople[senderId];

  if (profile) {
    respond(reply, profile, payload.message);
  } else {
    bot.getProfile(payload.sender.id, (err, profile) => {
      if (err) throw err
      knownPeople[senderId] = profile;

      respond(reply, profile, payload.message);
    });
  }
});

function respond(reply, profile, message) {

  var question = message.text;

  var foundSomethingToDo = false;
  var answer;

  if (question.search(/hello/i) !== -1) {
    foundSomethingToDo = true;
    console.log('they said hello! :)');
    answer = `Hello ${profile.first_name}!`;

    reply({ text: answer }, (err) => {
      if (err) throw err

      console.log(`Echoed back to ${profile.first_name} ${profile.last_name}: ${answer}`)
    })

  }


  if (question.search(/today/i) !== -1) {
    foundSomethingToDo = true;

    var dateInfo = getDate({ gDate: new Date() }, function (err, info) {
      if (err) {
        reply({ text: 'Sorry, ' + err }, (err) => {
          if (err) throw err
        })
      }

      reply({ text: info.text }, (err) => {
        if (err) {
          console.log(err);
          throw err;
        }
        console.log(`Sent date info`)
      })
    });
  }

  if (!foundSomethingToDo) {
    reply({ text: 'You can ask "today" and I can tell you what day it is now.' }, (err) => {
      if (err) {
        console.log(err);
      }
    })
  }

  //setTimeout(function () {
  //  text = 'Are you still there??';
  //  reply({ text }, (err) => {
  //    if (err) throw err

  //    console.log(`Sent reminder to ${profile.first_name} ${profile.last_name}: ${text}`)
  //  })

  //}, 10000);
}


http.createServer(bot.middleware()).listen(1844);
