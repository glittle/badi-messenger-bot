'use strict'
const http = require('http')
const Bot = require('messenger-bot');
const storage = require('node-persist');
const badiCalc = require('./badiCalc');
const sunCalc = require('./sunCalc');
const moment = require('moment-timezone');
const glob = require('glob');
const fs = require('fs');
const extend = require('node.extend');

var testEvery5seconds = false;
var manuallyStopped = false;
var timeout = null;
const maxAnswerLength = 319;

var sorryMsg = 'Oops... I had a problem just now. Sorry I wasn\'t able to reply. ' +
  'My programmer will have to fix something!';

var storageFolder = 'BadiBotStorage';
var storagePath = '../../../../' + storageFolder;

storage.initSync({
  dir: storagePath
});

//console.log(storage.keys());
//console.log(storage.getItem('reminders'));

var secrets = storage.getItem('secrets');
const timezonedb = require('timezonedb-node')(secrets.timeZoneKey);
var verses = null;


let bot = new Bot({
  token: secrets.botKey,
  verify: 'MyBadiBot'
});

bot.on('message', (payload, reply) => {

  var senderId = payload.sender.id;
  var key = makeKeys(senderId);

  var profile = storage.getItem(key.profile);
  //  var log = storage.getItem(key.log);

  if (profile) {
    try {
      respond(profile, payload.message, key);
    } catch (e) {
      console.log(e.stack);
      bot.sendMessage(profile.id, { text: sorryMsg });
    }
  } else {
    bot.getProfile(payload.sender.id, (err, profile) => {
      if (err) throw err
      profile.id = senderId;
      try {
        respond(profile, payload.message, key);
      } catch (e) {
        console.log(e.stack);
        bot.sendMessage(profile.id, { text: sorryMsg });
      }
    });
  }
});


function respond(profile, payloadMessage, keys) {
  var senderId = profile.id;
  var question = '';

  if (payloadMessage.text) {
    question = payloadMessage.text;
    console.log(`\nIncoming (${profile.first_name} ${profile.last_name} #${profile.visitCount || 'new'}): ${question}`);
    var answers = answerQuestions(question, profile, keys, []);
    sendAllAnswers(question, answers, profile, keys, null);
    return;
  }

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
          timezonedb.getTimeZoneData(coord,
            function (error, tzInfo) {
              if (!error) {
                //console.log(tzInfo);

                var userOffset = tzInfo.gmtOffset / 3600;
                var serverTz = new Date().getTimezoneOffset() / 60;
                var hourDifference = serverTz + userOffset;

                tzInfo.serverDiff = hourDifference;

                // reload and save the profile
                var profile = storage.getItem(keys.profile);
                profile.tzInfo = tzInfo;
                profile.coord = coord;
                storage.setItem(keys.profile, profile);

                var answerText = 'Great! Thanks for your location!';

                bot.sendMessage(senderId,
                {
                  text: answerText
                },
                (err) => {
                  if (err) {
                    console.log(err);
                  }
                });

                console.log(`Received location and timezone info for ${profile.first_name}.`);
                setTimeout(function () {
                  processSuntimes(senderId); // may be in a new location

                  var answers = answerQuestions('Remind after location update', profile, keys, []);
                  sendAllAnswers(question, answers, profile, keys, null);
                },
                  1000)

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
}

function answerQuestions(question, profile, keys, answers) {
  var senderId = profile.id;

  var questions = question.split(/;/g);
  if (questions.length > 1) {
    for (var q = 0; q < questions.length; q++) {
      answers = answerQuestions(questions[q], profile, keys, answers);
    }
    return answers;
  }

  // -------------------------------------------------------
  if (asking(question, ['hello', 'hi'])) {
    answers.push(`Hello ${profile.first_name}!`);

    if (!profile.tzInfo) {
      answers.push(`Please send me your Location using the Facebook Messenger mobile app, so that I can give you the correct date information!`);
      answers.push(`You can read full instructions here: http://bit.ly/BadiCalendarBot`);
    }
    if (profile.visitCount) {
      answers.push(`We have chatted ${profile.visitCount} times.`);
    }
  }

  // -------------------------------------------------------
  // if "DEV" commands expose secret information, can add a manual whitelist of developers
  if (asking(question, 'DEV STOP')) {
    // kill-switch
    answers.push('Stopped reminders');
    clearInterval(timeout);
    manuallyStopped = true;
  }
  // -------------------------------------------------------
  if (asking(question, 'DEV START')) {
    answers.push('Started reminders');
    manuallyStopped = false;
    prepareReminderTimer();
  }
  // -------------------------------------------------------
  if (asking(question, 'DEV VISITORS')) {
    answers.push(`Visitors list:`);
    glob(`../${storageFolder}/*_profile`, {

    }, function (er, files) {
      if (er) {
        console.log(er);
      } else {
        for (var i = 0; i < files.length; i++) {
          var p = JSON.parse(fs.readFileSync(files[i], 'utf8'));
          var info = ['\n' + p.first_name, p.visitCount, `\n` + p.id.substring(0,6)];
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
  if (asking(question, 'DEV REMINDERS')) {
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
  if (asking(question, 'CLEAR REMINDERS')) {

    var numCleared = processReminders(senderId, answers, true);
    if (numCleared) {
      answers.push(`Done. I've cleared your reminder(s) and won't send you the daily reminders any more.`);
    } else {
      answers.push(`I didn't find any reminders for you.`);
    }
  }

  // -------------------------------------------------------
  if (asking(question, ['REMIND WHEN','Remind after location update'])) {
    var numCleared = processReminders(senderId, answers, false);
    if (numCleared === 1) {
      answers.push(`That's the only reminder I have for you, ${profile.first_name}.`);
    } else if (numCleared) {
      answers.push(`Those are the reminders I have for you,  ${profile.first_name}.`);
    } else {
      if (question === 'Remind after location update') {
        answers.push('Now you can tell me when to remind you by saying, for example, "remind at 8" for 8 in the morning ' +
            'or "remind at sunset" for when the new day is starting.');
      } else {
        answers.push(`Sorry, ${profile.first_name}. I didn't find any reminders for you.`);
      }
    }
  }

  // -------------------------------------------------------
  if (asking(question, ['remind at', 'remind me at'])) {

    if (profile.tzInfo) {

      //dev
      var hourDifference = profile.tzInfo.serverDiff;

      var hours = '';
      var when = '';
      var details = {
        diff: hourDifference,
        zoneName: profile.tzInfo.zoneName
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

          answers.push(`Great! I'll try to let you know at ${when} each day about the current Badí' date.`);

          setTimeout(function () {
            processSuntimes(profile.id);
          }, 1000)
        }
      }

      if (when) {
        // reminders are shared... storage is not multi-user, so use it for very short times!
        var reminders = storage.getItem('reminders') || {};
        var reminderGroup = reminders[when] || {};
        reminderGroup[senderId] = extend(reminderGroup[senderId], details);
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
  if (asking(question, ['SUN TIMES'])) {
    badiCalc.addSunTimes(profile, answers);
  }

  // -------------------------------------------------------
  if (asking(question, ['TODAY', 'NOW'])) {
    if (profile.tzInfo) {
      badiCalc.addTodayInfoToAnswers(profile, answers);
      addVerse(profile, answers);
    }
  }

  // -------------------------------------------------------
  if (asking(question, 'VERSE')) {
    if (profile.tzInfo) {
      addVerse(profile, answers);
    }
  }

  // -------------------------------------------------------
  if (asking(question, 'HELP')) {

    answers.push('Here are the phrases that you can use when talking with me.');
    answers.push('\n"today"\nI\'ll tell you what Badí\' day it is where I am.');
    answers.push('\n"verse"\nI\'ll share the current passage from "Reciting the Verses of God"!');
    answers.push('\n\nAfter you send me your Location using the Facebook Messenger mobile app, I can send you reminders:');
    answers.push(`\n"remind at 21:30" or\n"remind at sunset"\nI\'ll send you reminders of Badí' date at those time(s).`)
    answers.push('\n"remind when?"\nI\'ll show you when I plan to remind you.')
    answers.push('\n"clear reminders"\nI\'ll stop sending you reminders.')
    answers.push('\nSee http://bit.ly/BadiCalendarBot for more details and phrases!')
  }

  // -------------------------------------------------------
  if (!answers.length) {
    answers.push('Say "help" to learn what the bot can understand! Read more here: http://bit.ly/BadiCalendarBot');
  }

  return answers;
}


function sendAllAnswers(question, answers, profile, key, originalAnswers) {
  if (!originalAnswers) {
    originalAnswers = JSON.parse(JSON.stringify(answers));
  }

  var keepGoing = true;

  if (answers.length) {
    // assume no single text is too long
    var answerText = answers.shift();

    for (var i = 0; keepGoing; i++) {
      if (!answers.length // past the end
          || (answerText && (answerText + answers[0]).length > maxAnswerLength)
          || answers[0] === '') {

        bot.sendMessage(profile.id, { text: answerText }, (err) => {
          if (err) {
            console.log(err);
            console.log(answerText);
          } else {
            console.log(`Sent: ${answerText}`)
            setTimeout(function () {
              sendAllAnswers(question, answers, profile, key, originalAnswers);
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
  var log = storage.getItem(key.log) || [];
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

  //  console.log('Before changes ------');
  //  console.log(reminders);

  var numChanged = 0;

  numChanged += addReminders('sunrise', reminders, now, noon, noonTomorrow, id);
  numChanged += addReminders('sunset', reminders, now, noon, noonTomorrow, id);

  if (numChanged) {
    // store reminders again
    //    console.log(numChanged + ' changed ----');
    //    console.log(reminders);
    storage.setItem('reminders', reminders);
  }
}

function addReminders(which, reminders, now, noon, noonTomorrow, idToProcess) {
  // if idToProcess is null, do everyone!
  var remindersAtWhichEvent = reminders[which];
  var numChanged = 0;

  for (var id in remindersAtWhichEvent) {
    if (remindersAtWhichEvent.hasOwnProperty(id)) {
      if (!idToProcess || idToProcess === id) {
        var profileStub = remindersAtWhichEvent[id];
        //        console.log(profileStub);

        //TODO update to use moment.tz!

        var lastSetFor = profileStub.lastSetFor;
        if (lastSetFor) {
          // remove old version
          var reminderGroup = reminders[lastSetFor];
          //          console.log(reminderGroup[id]);
          if (reminderGroup[id] && reminderGroup[id].customFor === which) {
            delete reminderGroup[id];
            console.log(`removed previous ${which} reminder.`)
            numChanged++;
          }
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
        profileStub.lastSetAt = moment().format(); // just for interest sake

        //console.log(profileStub);

        var reminderGroup = reminders[whenHHMM] || {};
        reminderGroup[id] = details;
        reminders[whenHHMM] = reminderGroup;
        numChanged++;
      }
    }
  }
  return numChanged;
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
            if (info.customFor) {
              answers.push(`The next ${info.customFor} reminder will be at ${info.userTime}.`);
            } else {
              answers.push(`➢ Remind at ${info.userTime || when}`);
            }
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
  var key = makeKeys(id);

  badiCalc.addTodayInfoToAnswers(profile, answers);
  addVerse(profile, answers);

  sendAllAnswers(`Reminder at ${serverWhen}`, answers, profile, key, null);
  //
  //  var answerText = answers.join('\n');
  //
  //  bot.sendMessage(id, {
  //    text: answerText
  //  }, (err) => {
  //    if (err) {
  //      console.log(err);
  //      console.log('Err1: ' + answerText);
  //    } else {
  //      console.log(`Reminder at ${serverWhen} - ${profile.first_name} ${profile.last_name}: ${answerText}`)
  //    }
  //  })

}

//function getUserNowTime(tzInfo) {
//  var now = new Date();
//  if (tzInfo) {
//    now.setHours(now.getHours() + tzInfo.serverDiff);
//  }
//  return now;
//}


//function getUserDateInfo(profile) {
//  var userDate = getUserNowTime(profile.tzInfo);
//  return {
//    now: userDate,
//    diff: profile.tzInfo ? profile.tzInfo.serverDiff : 0
//  };
//}

function loadProfile(id) {
  var key = id + '_profile';
  return storage.getItem(key);
}

function addHours(d, hours) {
  d.setHours(d.getHours() + hours);
}

function addVerse(profile, answers) {
  if (!verses) {
    console.log('verses not loaded');
    return;
  }
  var hour;
  var timeOfDay;
  var key;

  if (profile.tzInfo) {
    var zoneName = profile.tzInfo.zoneName;
    var nowTz = moment.tz(zoneName);
    key = nowTz.format('M.D');
    hour = nowTz.hour();
    timeOfDay = 'for this ' + (hour > 3 && hour < 12 ? 'morning' : (hour > 3 && hour < 18 ? 'afternoon/evening' : 'evening'));
  } else {
    // don't know user's time
    var now = moment();
    hour = now.hour(); // server time
    key = now.format('M.D');
    timeOfDay = 'for today';
  }
  var isAm = hour > 3 && hour < 12; // treat time after midnight as night, not morning
  var dayVerses = verses[key];
  if (dayVerses) {
    var verseInfo = dayVerses[isAm ? 'am' : 'pm'];
    if (verseInfo) {
      var prefix = `Our verse ${timeOfDay}: `;
      //var ellipses = ' ...';
      var ellipses = '';
      //      answers.push(prefix);

      var suffix = ` (Bahá'u'lláh, ${verseInfo.r})`;
      var verse = verseInfo.q;
      var answer = prefix + verse + suffix;

      if (answer.length > maxAnswerLength) {
        // can't be more than two maxAnswerLength
        var p_v = prefix + verse;
        if (p_v.length > maxAnswerLength) {
          // find 2nd last space...
          var space = p_v.lastIndexOf(' ', p_v.lastIndexOf(' ', maxAnswerLength - ellipses.length) - 1);
          console.log(space);
          var part1 = p_v.substring(0, space) + ellipses;
          var part2 = p_v.substring(space + 1);
          answers.push(part1);
          answers.push(part2 + suffix);
        } else {
          answers.push(p_v);
          answers.push(suffix);
        }

      } else {
        answers.push(answer);
      }

      //      var re = new RegExp('[\s\S]{1,' + maxAnswerLength + '}', 'g');
      //      for (var j = 0; j < answers.length; j++) {
      //        var a = answers[j];
      //        if (a.length > maxAnswerLength) {
      //          // need to split into smaller parts
      //          var parts = a.match(re)
      //        }
      //      }

    }
  }
}

function loadVersesAsync(cb) {
  fs.readFile('verses.json', 'utf8', (err, data) => {
    if (err) {
      console.log(err);
    } else {
      console.log('\nverses loaded');
      verses = JSON.parse(data);
      if (cb) {
        cb();
      }
    }
  });
}

function asking(question, text) {
  if (Array.isArray(text)) {
    for (var i = 0; i < text.length; i++) {
      if (asking(question, text[i])) {
        return true;
      }
    }
    return false;
  }
  return question.toUpperCase().indexOf(text.toUpperCase()) !== -1;
}

function makeKeys(senderId) {
  return {
    profile: senderId + '_profile',
    log: senderId + '_log'
  };
}

bot.on('error', (err) => {
  console.log(err.message)
})

prepareReminderTimer();
loadVersesAsync();

http.createServer(bot.middleware()).listen(1844);
