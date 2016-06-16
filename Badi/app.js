'use strict'
const http = require('http')
const Bot = require('messenger-bot');
const storage = require('node-persist');
const badiCalc = require('./badiCalc');
const moment = require('moment');
const glob = require('glob');
const fs = require('fs');

var testEvery5seconds = false;
var manuallyStopped = false;
var timeout = null;

var storageFolder = 'BadiBotStorage';
var storagePath = '../../../../' + storageFolder;

storage.initSync({
  dir: storagePath
});

var secrets = storage.getItem('secrets');
const timezonedb = require('timezonedb-node')(secrets.timeZoneKey);

let bot = new Bot({
  token: secrets.botKey,
  verify: 'MyBadiBot'
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
    respond(reply, profile, log, payload.message, key);
  } else {
    bot.getProfile(payload.sender.id, (err, profile) => {
      if (err) throw err
      profile.id = senderId;
      respond(reply, profile, log, payload.message, key);
    });
  }
});


function respond(reply, profile, log, payloadMessage, key) {
  var senderId = profile.id;
  var question = '';
  var answers = [];

  if (payloadMessage.text) {
    question = payloadMessage.text;
    console.log('\nIncoming (' + (profile.visitCount || 'new') + '): ' + question);
  } else {
    if (payloadMessage.attachments) {
      for (var i = 0; i < payloadMessage.attachments.length; i++) {
        var attach = payloadMessage.attachments[i];
        switch (attach.type) {
          case 'location':
            var lat = attach.payload.coordinates.lat;
            var long = attach.payload.coordinates.long;
            var coord = {
              lat: lat,
              lng: long
            };
            timezonedb.getTimeZoneData(coord, function (error, tzInfo) {
              if (!error) {
                console.log(tzInfo);

                var userOffset = tzInfo.gmtOffset / 3600;
                var serverTz = new Date().getTimezoneOffset() / 60;
                var hourDifference = serverTz + userOffset;

                tzInfo.serverDiff = hourDifference;

                // reload and save the profile
                var profile = storage.getItem(key.profile);
                profile.tzInfo = tzInfo;
                profile.coord = coord;
                storage.setItem(key.profile, profile);


                //console.log(hourDifference);
                //var testTime = new Date();
                //testTime.setHours(testTime.getHours() + hourDifference);

                //var userTime = new Date(tzInfo.timestamp * 1000);
                //userTime.setHours(userTime.getHours() - userOffset + hourDifference);
                //console.log(userTime);
                //var m = moment(userTime);

                var answerText = 'Great! Thanks for your location!\n\n'
                  + 'Now you can tell me when to remind you by saying, for example, "remind at 8" for 8 in the morning or "remind at 18" for 6 in the evening.';

                bot.sendMessage(senderId, {
                  text: answerText
                }, (err) => {
                  if (err) {
                    console.log(err);
                  }
                })
              } else {
                console.error(error);
              }
            });
            break;
          default:
            console.log(JSON.stringify(payloadMessage.attachments));
            answers.push('Thanks, but I don\'t know what to do with that!');
            break;
        }
      }
    }
    return;
  }





  // -------------------------------------------------------
  if (question.search(/HELLO/i) !== -1) {
    answers.push(`Hello ${profile.first_name}!`);

    if (!profile.tzInfo) {
      answers.push(`I don't know where you are! Please send me your Location using the Facebook Messenger mobile app, so I can give you the correct date information!`);
    }
    if (log && log.length) {
      answers.push(`We have chatted ${log.length} times.`);
    }
  }

  // -------------------------------------------------------
  // if "DEV" commands expose secret information, can add a manual whitelist of developers
  if (question.search(/DEV STOP/i) !== -1) {
    // kill-switch
    answers.push('Stopped reminders');
    clearInterval(timeout);
    manuallyStopped = true;
  }
  // -------------------------------------------------------
  if (question.search(/DEV START/i) !== -1) {
    answers.push('Started reminders');
    manuallyStopped = false;
    prepareReminderTimer();
  }
  // -------------------------------------------------------
  if (question.search(/DEV VISITORS/i) !== -1) {
    answers.push(`Visitors list:`);
    glob(`../${storageFolder}/*_profile`, {

    }, function (er, files) {
      if (er) {
        console.log(er);
      } else {
        for (var i = 0; i < files.length; i++) {
          var p = JSON.parse(fs.readFileSync(files[i], 'utf8'));
          var info = [p.first_name, p.visitCount];
          if (p.tzInfo) {
            info.push(p.tzInfo.countryCode);
          } else {
            info.push('no location');
          }
          answers.push(info.join('; '));
        }
        answers.push(`${files.length} visitors.`);
      }
      // files is an array of filenames.
      // If the `nonull` option is set, and nothing
      // was found, then files is ["**/*.js"]
      // er is an error object or null.
    })
  }
  // -------------------------------------------------------
  if (question.search(/DEV REMINDERS/i) !== -1) {
    answers.push('Reminders set for:');
    var reminders = storage.getItem('reminders') || {};

    for (var when in reminders) {
      if (reminders.hasOwnProperty(when)) {
        var reminderGroup = reminders[when];
        for (var id in reminderGroup) {
          var info = reminderGroup[id];
          var profile = info.profile;
          var tzInfo = profile.tzInfo;
          answers.push(`${when} - ${profile.first_name} - ${info.userHour} in ${tzInfo.countryCode} - ${tzInfo.zoneName}.`);
        }
      }
    }
  }

  // -------------------------------------------------------
  if (question.search(/CLEAR REMINDERS/i) !== -1) {

    var numCleared = processReminders(senderId, answers, true);
    if (numCleared) {
      answers.push(`Done. I've cleared your reminder(s) and won't send you the daily reminders any more.`);
    } else {
      answers.push(`I didn't find any reminders for you.`);
    }
  }

  // -------------------------------------------------------
  if (question.search(/REMIND WHEN/i) !== -1) {
    var numCleared = processReminders(senderId, answers, false);
    if (numCleared === 1) {
      answers.push(`That's the only reminder I have for you, ${profile.first_name}.`);
    } else if (numCleared) {
      answers.push(`Those are the reminders I have for you,  ${profile.first_name}.`);
    } else {
      answers.push(`Sorry, ${profile.first_name}. I didn't find any reminders for you.`);
    }
  }

  // -------------------------------------------------------
  if (question.search(/REMIND AT/i) !== -1) {

    if (profile.tzInfo) {

      //dev
      var hourDifference = profile.tzInfo.serverDiff;

      var hours = '';
      var when = '';
      var details = {
        diff: hourDifference
      };
      var matches = question.match(/\d{1,2}(:\d{2,2})?/);
      if (matches) {
        hours = matches[0];
      }
      if (hours) {
        var userTime = moment(hours, 'H:mm');

        if (userTime.isValid()) {
          answers.push(`Sounds good, ${profile.first_name}. I'll try to let you know around ${userTime
            .format('HH:mm')} about the Badí' date.`);

          when = moment(userTime).subtract(hourDifference, 'hours').format('HH:mm');
          details.userTime = userTime.format('HH:mm');
        }
      } else {
        matches = question.match(/(sunset|sunrise){1}/i);
        if (matches) {
          when = matches[0];
          details.coord = profile.coord;

          answers.push(`Sounds good, ${profile.first_name}. I'll try to let you know around ${when} about the current Badí' date.`);
        }
      }

      if (when) {
        // reminders are shared... storage is not multi-user, so use it for very short times!
        var reminders = storage.getItem('reminders') || {};
        var reminderGroup = reminders[when] || {};
        reminderGroup[senderId] = details;
        reminders[when] = reminderGroup;
        storage.setItem('reminders', reminders);

      } else {
        answers.push("Please include 'sunset' or give a time, like 21:30.");

      }
    } else {
      answers.push('Sorry, I can\'t remind you until I know your location.');
      answers.push('Please use the Facebook Messenger app to send me your location!');

    }
  }

  // -------------------------------------------------------
  if (question.search(/SUN TIMES/i) !== -1) {
    badiCalc.sunTimes(profile, answers);
  }

  // -------------------------------------------------------
  if (question.search(/TODAY/i) !== -1) {
    if (profile.tzInfo) {
      var now = new Date();
      var userDateInfo = getUserDateInfo(profile);

      badiCalc.today(profile, answers);
      //
      //      var dateInfo = badiCalc.getDate({ gDate: userDateInfo.now }, function (err, info) {
      //        if (err) {
      //          answers.push(err);
      //        } else {
      //          answers.push(`Hi ${profile.first_name}! ` + info.text);
      //        }
      //      });
      //    } else {
      //
      //      var dateInfo = badiCalc.getDate({ gDate: userDateInfo.now }, function (err, info) {
      //        if (err) {
      //          answers.push(err);
      //        } else {
      //          answers.push(`Hi ${profile.first_name}! ` + info.text);
      //        }
      //      });
      //    }
    }
  }

  // -------------------------------------------------------
  if (question.search(/HELP/i) === 0) {

    //var userDate = userDateInfo.now;

    answers.push('Here are the phrases that you can use when talking with me.');
    answers.push('');
    answers.push('⇒ "today"\nI\'ll tell you what Badí\' day it is now.');
    answers.push('⇒ "hello"\nI\'ll reply with your name.');
    answers.push('');
    answers.push('After you send me your Location using the Facebook Messenger mobile app, I can send you reminders:');
    answers.push('');
    answers.push(`⇒ "remind at 21:30" or "remind at sunset"\nI\'ll send you reminders of Badí' date at those time(s).`)
    answers.push('⇒ "remind when"?\nI\'ll show you when I plan to remind you.')
    answers.push('⇒ "clear reminders"\nI\'ll stop seding you reminder.')
    answers.push('');
    //answers.push('')
    //answers.push(`I'm assuming that it is about ${moment(userDate).format('HH:mm [on] MMMM D')} where you are. If that is not right, please let me know!`);
  }

  // -------------------------------------------------------
  if (!answers.length) {
    answers.push('Say "help" to learn what the bot can understand!');
  }

  sendAllAnswers(reply, question, answers, log, profile, key, null);

  //  if (!manuallyStopped) {
  //    prepareReminderTimer();
  //  }
}


function sendAllAnswers(reply, question, answers, log, profile, key, originalAnswers) {
  if (!originalAnswers) {
    originalAnswers = JSON.parse(JSON.stringify(answers));
  }

  //console.log('to send: ' + answers.length);
  var keepGoing = true;
  if (answers.length) {
    var answerText = answers.shift();

    for (var i = 0; keepGoing; i++) {
      if (!answers.length // past the end
          || (answerText && (answerText + answers[0]).length > 319)
          || answers[0] === '') {
        //console.log(`sending to ${profile.id}: ${answerText}`)
        bot.sendMessage(profile.id, { text: answerText }, (err) => {
          if (err) {
            console.log(err);
          } else {
            console.log(`Sent: ${answerText}`)
            setTimeout(function () {
              sendAllAnswers(reply, question, answers, log, profile, key, originalAnswers);
            }, 500);
          }
        });
        keepGoing = false;
      } else {
        answerText = [answerText, answers.shift()].join('\n');
      }
    }
    return;
  }

  // get it again
  log = storage.getItem(key.log) || [];
  log.push({
    when: new Date(),
    question: question,
    answers: originalAnswers
  });

  profile.visitCount = log.length;

  storage.setItem(key.profile, profile);
  storage.setItem(key.log, log);

  console.log('stored profile and log');
}

function prepareReminderTimer() {

  if (manuallyStopped) {
    return;
  }

  // time to next hour
  //var now = new Date();
  //var nextHour = new Date();
  //if (testEvery5seconds) {
  //  nextHour.setTime(now.getTime() + 5 * 1000);
  //} else {
  //  nextHour.setHours(now.getHours() + 1, 0, 0, 0);
  //}
  //var timeToNextHour = nextHour - now;

  clearInterval(timeout);
  timeout = setInterval(doReminders, 1000 * 60);

  //console.log(`(Reminders scheduled for ${nextHour.toTimeString()})`);
  console.log(`Reminder interval started for every minute.`);

  doReminders();
}

function doReminders() {
  //  clearTimeout(timeout);
  var reminders = storage.getItem('reminders');
  if (reminders) {
    var serverWhen = moment().format('HH:mm');
    process.stdout.write(`\rchecking reminders for ${serverWhen} (server time)`)

    var remindersAtWhen = reminders[serverWhen];
    if (remindersAtWhen) {
      for (var id in remindersAtWhen) {
        if (remindersAtWhen.hasOwnProperty(id)) {
          console.log('sending to ' + id);
          sendReminder(serverWhen, id, remindersAtWhen[id]);
        }
      }
    }
  }

  //  prepareReminderTimer();
}
function processReminders(currentId, answers, deleteReminders) {
  var num = 0;

  // reminders are shared... storage is not multi-user, so use it for very short times!
  var reminders = storage.getItem('reminders') || {};
  var saveNeeded = false;

  for (var when in reminders) {
    if (reminders.hasOwnProperty(when)) {
      var remindersAtWhen = reminders[when];
      for (var id in remindersAtWhen) {
        if (id === currentId) {
          var info = remindersAtWhen[id];

          //TODO if remove sunset, find reminder at actual time!

          if (deleteReminders) {
            delete remindersAtWhen[id];
            answers.push(`Removed reminder at ${info.userTime || when}.`);
          } else {
            answers.push(`Reminder set for ${info.userTime || when}.`);
          }
          num++;
        }
      }
      if (Object.keys(remindersAtWhen).length === 0) {
        delete reminders[when];
        saveNeeded = true;
      }
    }
  }
  if (saveNeeded || (num > 0 && deleteReminders)) {
    storage.setItem('reminders', reminders);
  }
  return num;
}

function sendReminder(serverWhen, id, info) {
  var answers = [];

  var profile = loadProfile(id);
  //  var userDateInfo = getUserDateInfo(profile);
  badiCalc.today(profile, answers);
  //  var dateInfo = badiCalc.today({ gDate: userDateInfo.now }, function (err, info) {
  //    if (err) {
  //      console.log(err);
  //    } else {
  //      answers.push(`Hello ${profile.first_name}. ` + info.text);
  //    }
  //  });

  var answerText = answers.join('\n');

  bot.sendMessage(id, {
    text: answerText
  }, (err) => {
    if (err) {
      console.log(err);
    } else {
      console.log(`Reminder at ${serverWhen} - ${profile.first_name} ${profile.last_name}: ${answerText}`)
    }
  })

}

function getUserNowTime(tzInfo) {
  var now = new Date();
  if (tzInfo) {
    now.setHours(now.getHours() + tzInfo.serverDiff);
  }
  return now;
}


function getUserDateInfo(profile) {
  var userDate = getUserNowTime(profile.tzInfo);
  //var tz = profile.timezone;
  //var serverTz = userDate.getTimezoneOffset() / 60;
  //var hourDifference = serverTz + tz;
  //userDate.setHours(userDate.getHours() + hourDifference);
  return {
    now: userDate,
    diff: profile.tzInfo ? profile.tzInfo.serverDiff : 0
  };
}

function loadProfile(id) {
  var key = id + '_profile';
  return storage.getItem(key);
}


bot.on('error', (err) => {
  console.log(err.message)
})

prepareReminderTimer();

http.createServer(bot.middleware()).listen(1844);
