'use strict'
const http = require('http')
const Bot = require('messenger-bot');
const storage = require('node-persist');
const getDate = require('./badiCalc');

var timeout = null;
var manuallyStopped = true;

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
    profile: 'profile_' + senderId,
    log: 'profile_' + senderId + '_log',
    reminders: 'reminders'
  };

  var profile = storage.getItem(key.profile);
  var log = storage.getItem(key.log);
  var reminders = storage.getItem(key.reminders) || {};

  if (profile) {
    console.log('Incoming (' + profile.visitCount + '): ' + payload.message.text);
    respond(reply, profile, log, payload.message.text, key, reminders, senderId);
  } else {
    bot.getProfile(payload.sender.id, (err, profile) => {
      if (err) throw err
      console.log('Incoming (new):' + payload.message.text);
      respond(reply, profile, log, payload.message.text, key, reminders, senderId);
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

function respond(reply, profile, log, question, key, reminders, senderId) {

  var answer = [];
  console.log(question);
  var userDateInfo = getUserDateInfo(profile);

  if (question.search(/hello/i) !== -1) {
    answer.push(`Hello ${profile.first_name}!`);
  }
  if (question.search(/dev stop/i) !== -1) {
    answer.push('Stopped reminders');
    clearTimeout(timeout);
    manuallyStopped = true;
  }
  if (question.search(/dev start/i) !== -1) {
    answer.push('Started reminders');
    prepareReminderTimer();
    manuallyStopped = false;
  }

  if (question.search(/clear reminders/i) !== -1) {
    var numCleared = clearReminders(reminders, senderId, answer, true);
    if (numCleared) {
      answer.push(`I've cleared your reminder(s) and won't send you the daily reminders any more.`);
    } else {
      answer.push(`I didn't find any reminders for you.`);
    }
  }

  if (question.search(/remind when/i) !== -1) {
    var numCleared = clearReminders(reminders, senderId, answer, false);
    if (numCleared) {
      answer.push(`Those are the reminder(s) I have for you.`);
    } else {
      answer.push(`I didn't find any reminders for you.`);
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

    answer.push(`I'll try to let you know around ${hours}:00 about the Badí' date.`);

    var localReminderHour = Math.floor(hours + hourDifference); // don't deal with partial hours
    if (localReminderHour > 23) {
      localReminderHour = localReminderHour - 24;
    }
    var reminderGroup = reminders[localReminderHour] || {};
    reminderGroup[senderId] = profile; // avoid duplicates
    reminders[localReminderHour] = reminderGroup;
    //console.log(localReminderHour);
    //console.log(reminders);
    storage.setItem(key.reminders, reminders);
  }


  if (question.search(/today/i) !== -1) {
    var dateInfo = getDate({ gDate: userDateInfo.now }, function (err, info) {
      if (err) {
        answer.push(err);
      } else {
        answer.push(info.text);
      }
    });
  }

  if (!answer.length) {

    var userDate = userDateInfo.now;

    answer.push('Magic phrases that I should recognize:');
    answer.push('  hello --> I\'ll reply with your name');
    answer.push('  today --> I\'ll tell you what Badí\' day it is now\n');
    answer.push("  remind at 21 --> I\'ll send you a reminder of Badí' date at that hour (use any hour)")
    answer.push('  remind when --> I\'ll show you when I plan to remind you')
    answer.push('  clear reminders --> I\'ll stop reminding you')
    answer.push('  ')
    answer.push(`I'm assuming that it is about ${userDate.toLocaleTimeString()} on ${userDate.toDateString()} where you are.\n`);

    if (log && log.length) {
      answer.push(`We have chatted ${log.length} times!`);
    }
  }

  var answerText = null;
  for (var i = 0; i <= answer.length; i++) {
    if (i == answer.length || (answerText + answer[i]).length > 319) {
      reply({ text: answerText }, (err) => {
        if (err) {
          console.log(err);
        } else {
          console.log(`Answered: ${answerText}`)
        }
      })
      if (i == answer.length) {
        break;
      }
      answerText = null;
    }
    answerText = [answerText, answer[i]].join('\n');
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

  if (!manuallyStopped) {
    prepareReminderTimer();
  }
  //setTimeout(function () {
  //  text = 'Are you still there??';
  //  reply({ text }, (err) => {
  //    if (err) throw err

  //    console.log(`Sent reminder to ${profile.first_name} ${profile.last_name}: ${text}`)
  //  })

  //}, 10000);
}

function prepareReminderTimer() {
  clearTimeout(timeout);

  if (manuallyStopped) {
    return;
  }

  var inDevelopment = true;

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
function clearReminders(reminders, currentId, answer, actuallyDelete) {
  var num = 0;
  for (var hour in reminders) {
    if (reminders.hasOwnProperty(hour)) {
      var reminderGroup = reminders[hour];
      for (var id in reminderGroup) {
        if (id === currentId) {
          if (actuallyDelete) {
            answer.push(`Removed reminder at ${hour}:00.`);
            delete reminderGroup[id];
          } else {
            answer.push(`Reminder set for ${hour}:00.`);
          }
          num++;
        }
      }
    }
  }
  storage.setItem('reminders', reminders);
  return num;
}

function sendReminder(id, profile) {
  var answer = [];
  var userDateInfo = getUserDateInfo(profile);
  var dateInfo = getDate({ gDate: userDateInfo.now }, function (err, info) {
    if (err) {
      console.log(err);
    } else {
      answer.push(info.text);
    }
  });

  var answerText = answer.join('\n\n');

  bot.sendMessage(id, {
    text: answerText
  }, (err) => {
    if (err) {
      console.log(err);
    } else {
      console.log(`Reminded ${profile.first_name} ${profile.last_name}: ${answerText}`)
    }
  })

}

prepareReminderTimer();

http.createServer(bot.middleware()).listen(1844);
