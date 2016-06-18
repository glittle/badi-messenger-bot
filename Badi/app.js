'use strict'
const http = require('http')
const Bot = require('messenger-bot');
const storage = require('node-persist');
const badiCalc = require('./badiCalc');
const sunCalc = require('./sunCalc');
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
    try {
      respond(reply, profile, log, payload.message, key);
    } catch (e) {
      console.log(e);
      console.log(e.stacktrace);
      bot.sendMessage(profile.id, { text: 'Oops... I have a problem. Sorry I can\'t help right now.' });
    }
  } else {
    bot.getProfile(payload.sender.id, (err, profile) => {
      if (err) throw err
      profile.id = senderId;
      try {
        respond(reply, profile, log, payload.message, key);
      } catch (e) {
        console.log(e);
        console.log(e.stacktrace);
        bot.sendMessage(profile.id, { text: 'Oops... I have a problem. Sorry I can\'t help right now.' });
      }
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

                var answerText = 'Great! Thanks for your location!\n\n'
                  + 'Now you can tell me when to remind you by saying, for example, "remind at 8" for 8 in the morning or "remind at sunset" for when the new day is starting.';

                bot.sendMessage(senderId,
                {
                  text: answerText
                },
                (err) => {
                  if (err) {
                    console.log(err);
                  }
                });

                console.log('Received location and timezone info!');
                setTimeout(function () {
                  processSuntimes(senderId); // may be in a new location
                }, 1000)

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

          var sunTimes = badiCalc.getSunTimes(profile);

          answers.push(`Sounds good, ${profile.first_name}. I'll try to let you know around ${when} about the current Badí' date.`);
          answers.push(`\nToday's ${when}: ${moment(sunTimes[when]).format('HH:mm')}`);

          setTimeout(function () {
            processSuntimes(profile.id);
          }, 1000)
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

      badiCalc.addTodayInfoToAnswers(profile, answers);
    }
  }

  // -------------------------------------------------------
  if (question.search(/HELP/i) === 0) {

    answers.push('Here are the phrases that you can use when talking with me.');
    answers.push('');
    answers.push('⇒ "today"\nI\'ll tell you what Badí\' day it is where I am.');
    answers.push('⇒ "hello"\nI\'ll reply with your name.');
    answers.push('');
    answers.push('After you send me your Location using the Facebook Messenger mobile app, I can send you reminders:');
    answers.push('');
    answers.push('⇒ "today"\nI\'ll tell you what Badí\' day it is where you are.');
    answers.push(`⇒ "remind at 21:30" or "remind at sunset"\nI\'ll send you reminders of Badí' date at those time(s).`)
    answers.push('⇒ "remind when"?\nI\'ll show you when I plan to remind you.')
    answers.push('⇒ "clear reminders"\nI\'ll stop sending you reminders.')
    answers.push('⇒ "sun times"\nI\'ll send you today\'s sunrise and sunset times.')
    answers.push('');
  }

  // -------------------------------------------------------
  if (!answers.length) {
    answers.push('Say "help" to learn what the bot can understand!');
  }

  sendAllAnswers(reply, question, answers, log, profile, key, null);

}


function sendAllAnswers(reply, question, answers, log, profile, key, originalAnswers) {
  if (!originalAnswers) {
    originalAnswers = JSON.parse(JSON.stringify(answers));
  }

  var keepGoing = true;
  if (answers.length) {
    var answerText = answers.shift();

    for (var i = 0; keepGoing; i++) {
      if (!answers.length // past the end
          || (answerText && (answerText + answers[0]).length > 319)
          || answers[0] === '') {

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

  clearInterval(timeout);
  timeout = setInterval(doReminders, 1000 * 60);

  console.log(`Reminder interval started for every minute.`);

  doReminders();
}

function processSuntimes(id) {
  console.log('process suntimes ' + id);

  var now = moment().add(1, 'minutes').toDate(); // needs to be at least one minute in the future!
  var noon = moment().hours(12);
  var noonTomorrow = moment(noon).add(1, 'days');

  var reminders = storage.getItem('reminders');

  var numAdded = 0;

  numAdded += addReminders('sunrise', reminders, now, noon, noonTomorrow, id);
  numAdded += addReminders('sunset', reminders, now, noon, noonTomorrow, id);

  if (numAdded) {
    // store reminders again
    storage.setItem('reminders', reminders);
  }
}

function addReminders(which, reminders, now, noon, noonTomorrow, idToProcess) {
  // if idToProcess is null, do everyone!
  var remindersAtWhichEvent = reminders[which];
  var numAdded = 0;

  for (var id in remindersAtWhichEvent) {
    if (remindersAtWhichEvent.hasOwnProperty(id)) {
      if (!idToProcess || idToProcess === id) {
        var profileStub = remindersAtWhichEvent[id];

        var lastSetFor = profileStub.lastSetFor;
        if (lastSetFor) {
          // remove old version
          var reminderGroup = reminders[lastSetFor];
          delete reminderGroup[id];
        }

        var coord = profileStub.coord;

        var sunTimes = sunCalc.getTimes(noon.toDate(), coord.lat, coord.lng)
        var when = sunTimes[which];

        if (now > when) {
          sunTimes = sunCalc.getTimes(noonTomorrow.toDate(), coord.lat, coord.lng)
          when = sunTimes[which];
        }

        var momentWhen = moment(when);
        var details = {
          diff: profileStub.diff,
          userTime: moment(momentWhen).add(profileStub.diff, 'hours').format('HH:mm'),
          customFor: which
        };

        var whenHHMM = momentWhen.format('HH:mm');
        console.log('added for ' + whenHHMM)

        profileStub.lastSetFor = whenHHMM;
        profileStub.lastSetAt = momentWhen.format(); // just for interest sake

        var reminderGroup = reminders[whenHHMM] || {};
        reminderGroup[id] = details;
        reminders[whenHHMM] = reminderGroup;
        numAdded++;
      }
    }
  }
  return numAdded;
}

function doReminders() {

  var reminders = storage.getItem('reminders');
  if (reminders) {
    var serverWhen = moment().format('HH:mm');
    process.stdout.write(`\rchecking reminders for ${serverWhen} (server time)`)

    var saveNeeded = false;
    var remindersAtWhen = reminders[serverWhen];
    if (remindersAtWhen) {
      for (var id in remindersAtWhen) {
        if (remindersAtWhen.hasOwnProperty(id)) {
          console.log('sending to ' + id);
          var info = remindersAtWhen[id];
          sendReminder(serverWhen, id, info);

          if (info.customFor) {

            delete remindersAtWhen[id];
            saveNeeded = true;

            setTimeout(function (idToProcess) {
              processSuntimes(idToProcess);
            }, 5 * 60 * 1000, id); // five minutes... sunset may delay by a few minutes...
          }
        }
      }
    }

    if (saveNeeded) {
      storage.setItem('reminders', reminders);
    }
  }

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


          if (deleteReminders) {

            //TODO find reminder at actual time!

            delete remindersAtWhen[id];
            answers.push(`Removed reminder at ${info.userTime || when}.`);
          } else {
            answers.push(`Reminder set for ${info.customFor ? 'next ' + info.customFor + ' at ' : ''}${info.userTime || ('each ' + when)}.`);
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
  console.log(info);
  var profile = loadProfile(id);

  badiCalc.addTodayInfoToAnswers(profile, answers);

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
  return {
    now: userDate,
    diff: profile.tzInfo ? profile.tzInfo.serverDiff : 0
  };
}

function loadProfile(id) {
  var key = id + '_profile';
  return storage.getItem(key);
}

function addHours(d, hours) {
  d.setHours(d.getHours() + hours);
}



bot.on('error', (err) => {
  console.log(err.message)
})

prepareReminderTimer();

http.createServer(bot.middleware()).listen(1844);
