'use strict'
const http = require('http')
const Bot = require('messenger-bot');
const storage = require('node-persist');
const getDate = require('./badiCalc');
const moment = require('moment');

var timeout = null;
var manuallyStopped = false;

let bot = new Bot({
  token: 'EAASZCBdZBZCAw4BAENLsG9yFr82PVd5A9nAoWqvMZAxD1OZCpVkDUGCgU1jI51fEon5qbZASaFpSRgG7IQqZC207K5ucZAFXqZCzLivhE6euolx7yG8lUIW9FblgtvGzArutftE2b2ZC5sHhYZB7tlEEBiaYQTHjgRnfaZBBJBl09kGG8wZDZD',
  verify: 'MyBadiBot'
});

bot.on('error', (err) => {
  console.log(err.message)
})

storage.initSync({
  dir: '../../../../BadiBotStorage'
});


bot.on('message', (payload, reply) => {

  var senderId = payload.sender.id;
  var key = {
    profile: senderId + '_profile',
    log: senderId + '_log'
  };

  var profile = storage.getItem(key.profile);
  var log = storage.getItem(key.log);

  if (profile) {
    console.log('Incoming (' + profile.visitCount + '): ' + payload.message.text);
    respond(reply, profile, log, payload.message.text, key);
  } else {
    bot.getProfile(payload.sender.id, (err, profile) => {
      if (err) throw err
      profile.id = senderId;
      console.log('Incoming (new):' + payload.message.text);
      respond(reply, profile, log, payload.message.text, key);
    });
  }
});

function getUserDateInfo(profile) {
  var userDate = new Date();
  var tz = profile.timezone;
  var serverTz = userDate.getTimezoneOffset() / 60;
  var hourDifference = serverTz + tz;
  userDate.setHours(userDate.getHours() + hourDifference);
  return {
    now: userDate,
    diff: hourDifference
  };
}

function respond(reply, profile, log, question, key) {
  var senderId = profile.id;
  var answers = [];
  console.log(question);
  var userDateInfo = getUserDateInfo(profile);

  if (question.search(/hello/i) !== -1) {
    answers.push(`Hello ${profile.first_name}!`);

    if (log && log.length) {
      answers.push(`We have chatted ${log.length} times!`);
    }
  }
  if (question.search(/dev stop/i) !== -1) {
    answers.push('Stopped reminders');
    clearTimeout(timeout);
    manuallyStopped = true;
  }
  if (question.search(/dev start/i) !== -1) {
    answers.push('Started reminders');
    prepareReminderTimer();
    manuallyStopped = false;
  }

  if (question.search(/clear reminders/i) !== -1) {

    var numCleared = clearReminders(senderId, answers, true);
    if (numCleared) {
      answers.push(`Done. I've cleared your reminder(s) and won't send you the daily reminders any more.`);
    } else {
      answers.push(`I didn't find any reminders for you.`);
    }
  }

  if (question.search(/remind when/i) !== -1) {
    var numCleared = clearReminders(senderId, answers, false);
    if (numCleared === 1) {
      answers.push(`That's the only reminder I have for you, ${profile.first_name}.`);
    } else if (numCleared) {
      answers.push(`Those are the reminders I have for you,  ${profile.first_name}.`);
    } else {
      answers.push(`Sorry, ${profile.first_name}. I didn't find any reminders for you.`);
    }
  }

  if (question.search(/remind at/i) !== -1) {

    //dev
    var hourDifference = userDateInfo.diff;

    var hours = 21;
    var matches = question.match(/\d+/);
    if (matches) {
      hours = +matches[0];
    }

    answers.push(`Sounds good, ${profile.first_name}. I'll try to let you know around ${hours}:00 about the Badí' date.`);

    var localReminderHour = Math.floor(hours + hourDifference); // don't deal with partial hours
    if (localReminderHour > 23) {
      localReminderHour = localReminderHour - 24;
    }

    // reminders are shared... storage is not multi-user, so use it for very short times!
    var reminders = storage.getItem('reminders') || {};
    var reminderGroup = reminders[localReminderHour] || {};
    reminderGroup[senderId] = {
      profile: profile,
      userHour: hours
    }
    reminders[localReminderHour] = reminderGroup;
    //console.log(localReminderHour);
    //console.log(reminders);
    storage.setItem('reminders', reminders);
  }


  if (question.search(/today/i) !== -1) {
    var dateInfo = getDate({ gDate: userDateInfo.now }, function (err, info) {
      if (err) {
        answers.push(err);
      } else {
        answers.push(`Hi ${profile.first_name}! ` + info.text);
      }
    });
  }

  if (!answers.length) {

    var userDate = userDateInfo.now;

    answers.push('Here are the phrases that you can use when talking with me.');
    answers.push('');
    answers.push('⇒ "today"\nI\'ll tell you what Badí\' day it is now.');
    answers.push('');
    answers.push(`⇒ "remind at" 21:00\nI\'ll send you a reminder of Badí' date at the top of that hour. Use any hour from 0 - 23.`)
    answers.push('⇒ "remind when"?\nI\'ll show you when I plan to remind you.')
    answers.push('⇒ "clear reminders"\nI\'ll stop reminding you.')
    answers.push('');
    answers.push('⇒ "hello"\nI\'ll reply with your name.');
    answers.push('')
    answers.push(`I'm assuming that it is about ${moment(userDate).format('HH:mm [on] MMMM D')} where you are. If that is not right, please let me know!`);

  }

  sendAllAnswers(reply, question, answers, log, profile, key, null);

  if (!manuallyStopped) {
    prepareReminderTimer();
  }
}

function sendAllAnswers(reply, question, answers, log, profile, key, originalAnswers) {
  if (!originalAnswers) {
    originalAnswers = JSON.parse(JSON.stringify(answers));
  }
  console.log('to send: ' + answers.length);
  var keepGoing = true;
  if (answers.length) {
    var answerText = answers.shift();

    for (var i = 0; keepGoing; i++) {
      if (!answers.length // past the end
          || (answerText && (answerText + answers[0]).length > 319)
          || answers[0] === '') {
        console.log(`sending to ${profile.id}: ${answerText}`)
        bot.sendMessage(profile.id, { text: answerText }, (err) => {
          if (err) {
            console.log(err);
          } else {
            console.log(`Sent: ${answerText}`)
            if (answers.length) {
              setTimeout(function () {
                sendAllAnswers(reply, question, answers, log, profile, key, originalAnswers);
              }, 500);
            }
          }
        });
        keepGoing = false;
      } else {
        answerText = [answerText, answers.shift()].join('\n');
      }
    }
    if (answers.length) {
      return;
    }
  }

  if (!log) log = [];

  log.push({
    when: new Date(),
    question: question,
    answers: originalAnswers
  });

  console.log('storing profile and log');

  profile.visitCount = log.length;

  storage.setItem(key.profile, profile);
  storage.setItem(key.log, log);

}

function prepareReminderTimer() {
  clearTimeout(timeout);

  if (manuallyStopped) {
    return;
  }

  var inDevelopment = false;

  // time to next hour
  var now = new Date();
  var nextHour = new Date();
  if (inDevelopment) {
    nextHour.setTime(now.getTime() + 5 * 1000);
  } else {
    nextHour.setHours(now.getHours() + 1, 0, 0, 0);
  }
  var timeToNextHour = nextHour - now;

  console.log(`Reminders scheduled for ${nextHour.toTimeString()}`);

  timeout = setTimeout(doReminders, timeToNextHour);
}

function doReminders() {
  var reminders = storage.getItem('reminders');
  if (reminders) {
    var thisHour = new Date().getHours();
    console.log(`checking reminders for ${thisHour}:00 (server time)`)

    var reminderGroup = reminders[thisHour];
    if (reminderGroup) {
      for (var id in reminderGroup) {
        if (reminderGroup.hasOwnProperty(id)) {
          console.log('sending to ' + id);
          sendReminder(id, reminderGroup[id]);
        }
      }
    }
  }

  prepareReminderTimer();
}
function clearReminders(currentId, answers, actuallyDelete) {
  var num = 0;

  // reminders are shared... storage is not multi-user, so use it for very short times!
  var reminders = storage.getItem('reminders') || {};

  for (var hour in reminders) {
    if (reminders.hasOwnProperty(hour)) {
      var reminderGroup = reminders[hour];
      for (var id in reminderGroup) {
        if (id === currentId) {
          var info = reminderGroup[id];
          if (actuallyDelete) {
            answers.push(`Removed reminder at ${info.userHour}:00.`);
            delete reminderGroup[id];
          } else {
            answers.push(`Reminder set for ${info.userHour}:00.`);
          }
          num++;
        }
      }
    }
  }
  storage.setItem('reminders', reminders);
  return num;
}

function sendReminder(id, info) {
  var answers = [];
  var profile = info.profile;
  var userDateInfo = getUserDateInfo(profile);
  var dateInfo = getDate({ gDate: userDateInfo.now }, function (err, info) {
    if (err) {
      console.log(err);
    } else {
      answers.push(`Hello ${profile.first_name}. ` + info.text);
    }
  });

  var answerText = answers.join('\n');

  bot.sendMessage(id, {
    text: answerText
  }, (err) => {
    if (err) {
      console.log(err);
    } else {
      console.log(`Reminded for ${info.userHour}:00 ${profile.first_name} ${profile.last_name}: ${answerText}`)
    }
  })

}

prepareReminderTimer();

http.createServer(bot.middleware()).listen(1844);
