'use strict'
const http = require('http')
const fs = require('fs');
const glob = require('glob');
const Bot = require('messenger-bot');
const storage = require('node-persist');
const moment = require('moment-timezone');
const extend = require('node.extend');
const badiCalc = require('./badiCalc');
const sunCalc = require('./sunCalc');

//const forceNewMessageChar = '$%';
const maxAnswerLength = 319;
const sorryMsg = 'Oops... I had a problem just now. Sorry I wasn\'t able to reply properly. ' +
  'My programmer will have to fix something!';

const storageFolder = 'BadiBotStorage';
const storagePath = '../../../../' + storageFolder;

var manuallyStopped = false; // remote kill switch!
var reminderInterval = null;

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
      profile.firstVisit = moment().format();
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
  if (isAsking(question, ['hello', 'hi'])) {
    answers.push(`Hello ${profile.first_name}!`);

    notifyDeveloper('New user: ' + profile.first_name);

    if (profile.visitCount) {
      answers.push(`We have chatted ${profile.visitCount} times!`);
    } else {
      answers.push(`I'm pleased to meet you!\n`);
    }

    if (!profile.tzInfo) {
      answers.push(`Please send me your Location using the Facebook Messenger mobile app, so that I know where you are!`);
      answers.push(`You can read full instructions here: http://bit.ly/BadiCalendarBot`);
    }
  }

  // -------------------------------------------------------
  if (isAsking(question, 'DEV STOP')) {
    // kill-switch
    answers.push('Stopped reminders');
    clearInterval(reminderInterval);
    manuallyStopped = true;
  }
  // -------------------------------------------------------
  if (isAsking(question, 'DEV START')) {
    answers.push('Started reminders');
    manuallyStopped = false;
    prepareReminderTimer();
  }

  // -------------------------------------------------------
  if (isAsking(question, ['DEV VISITORS', 'DEV VISITORS NEW', 'DEV NEW']) && isDeveloperId(senderId)) {
    answers.push(`Checking the visitors list...`);
    glob(`../${storageFolder}/*_profile`, {

    }, function (er, files) {
      if (er) {
        console.log(er);
      } else {
        var askingForNew = question.toUpperCase().indexOf('NEW') !== -1;
        var numNew = 0;
        const diffDays = 7;
        var numWithLocation = 0;
        var profiles = [];
        for (var i = 0; i < files.length; i++) {
          var profile = JSON.parse(fs.readFileSync(files[i], 'utf8'));
          profile.isNew = profile.firstVisit
            && moment().diff(moment(profile.firstVisit), 'days') < diffDays;
          if (profile.isNew) {
            numNew++;
          }
          numWithLocation += profile.tzInfo ? 1 : 0;
          profiles.push(profile);
        }
        profiles.sort(function (a, b) {
          // sort those with locations first
          if (!!a.tzInfo === !!b.tzInfo) {
            return a.first_name > b.first_name ? 1 : -1;
          }
          if (a.tzInfo) {
            return -1;
          }
          return 1;
        });
        if (!askingForNew) {
          answers.push(`I've had ${files.length} visitors.`);
          answers.push(`${numNew} new* in the last ${diffDays} days.`);
          answers.push(`These ${numWithLocation} have a location:`);
        } else {
          answers.push(`${numNew} new in the last ${diffDays} days.`);
        }
        var showingWithLocations = true; // in practice, first will always have a location
        for (var i = 0; i < profiles.length; i++) {
          var p = profiles[i];

          if (askingForNew && !p.isNew) {
            continue;
          }
          var hasLocation = !!p.tzInfo;

          if (showingWithLocations && !hasLocation) {
            answers.push(`\nThese ${profiles.length - i} have no location:`);
            //            answers.push(forceNewMessageChar + 'Those with no location...');
            showingWithLocations = false;
          }

          var info = [(p.first_name || '').substring(0, 8) + (!askingForNew && p.isNew ? '*' : '')];
          if (hasLocation) {
            info.push(p.tzInfo.countryCode);
            //          } else {
            //            info.push('no location');
          }
          info.push('x' + p.visitCount);
          info.push(p.id.substring(0, 5));
          answers.push(info.join(', '));
        }
      }
    })
  }
  // -------------------------------------------------------
  if (isAsking(question, 'DEV REMINDERS')) {
    answers.push('Reminders set for:');
    var reminders = storage.getItem('reminders') || {};

    for (var when in reminders) {
      if (reminders.hasOwnProperty(when)) {
        answers.push('---' + when + '---');
        var reminderGroup = reminders[when];
        for (var id in reminderGroup) {
//          console.log(id);
          var info = reminderGroup[id];
//          console.log(info);
          answers.push(`${id.substring(0, 5)} ${info.userTime || ''} ${info.customFor || ''} (${info.diff}).`);
        }
      }
    }
  }

  // -------------------------------------------------------
  if (isAsking(question, 'CLEAR REMINDERS')) {

    var numCleared = processReminders(senderId, answers, true);
    if (numCleared) {
      answers.push(`Done. I've cleared your reminder(s) and won't send you the daily reminders any more.`);
    } else {
      answers.push(`I didn't find any reminders for you.`);
    }
  }

  // -------------------------------------------------------
  if (isAsking(question, ['REMIND WHEN', 'Remind after location update'])) {
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
  if (isAsking(question, ['remind at', 'remind me at'])) {

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
      answers.push(`Sorry ${profile.first_name}, I can\'t remind you until I know your location.`);
      answers.push('Please use the Facebook Messenger app to send it to me.' +
        ' If you are not sure how to do that, see http://bit.ly/BadiCalendarBot.');
    }
  }

  // -------------------------------------------------------
  if (isAsking(question, ['SUN TIMES'])) {
    badiCalc.addSunTimes(profile, answers);
  }

  // -------------------------------------------------------
  if (isAsking(question, ['TODAY', 'NOW'])) {
    if (profile.tzInfo) {
      badiCalc.addTodayInfoToAnswers(profile, answers);
      addVerse(profile, answers);
    }
  }

  // -------------------------------------------------------
  if (isAsking(question, 'VERSE')) {
    if (profile.tzInfo) {
      addVerse(profile, answers);
    }
  }

  // -------------------------------------------------------
  if (isAsking(question, 'HELP')) {

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
    answers.push('Say "help" to learn what the bot can do. See http://bit.ly/BadiCalendarBot for complete details!');
  }

  return answers;
}

function sendAllAnswers(question, answers, profile, keys, originalAnswers) {
  if (!originalAnswers) {
    originalAnswers = JSON.parse(JSON.stringify(answers));
  }

  var keepGoing = true;

  if (answers.length) {
    // assume no single text is too long
    var answerText = answers.shift();

    for (var i = 0; keepGoing; i++) {
      //      var wantNewMessage = answerText.indexOf(forceNewMessageChar) === 0;

      if (!answers.length // past the end
          || (answerText && (answerText + answers[0]).length > maxAnswerLength)
        //          || wantNewMessage
          || answers[0] === '') {

        //        if (wantNewMessage) {
        //          answerText = answerText.replace(forceNewMessageChar, '');
        //        }

        bot.sendMessage(profile.id, { text: answerText }, (err) => {
          if (err) {
            console.log(err);
            console.log(answerText);
          } else {
            console.log(`Sent: ${answerText}`)
            setTimeout(function () {
              sendAllAnswers(question, answers, profile, keys, originalAnswers);
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
  var log = storage.getItem(keys.log) || [];
  log.push({
    when: new Date(),
    question: question,
    answers: originalAnswers
  });

  profile.visitCount = log.length;

  storage.setItem(keys.profile, profile);
  storage.setItem(keys.log, log);

  console.log('stored profile and log');
}

function prepareReminderTimer() {

  if (manuallyStopped) {
    return;
  }

  clearInterval(reminderInterval);
  reminderInterval = setInterval(doReminders, 1000 * 60);

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
            saveNeeded = true;
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
  if (saveNeeded) {
    storage.setItem('reminders', reminders);
  }
  return num;
}

function sendReminder(serverWhen, id, info) {
  var answers = [];
  var profile = getProfile(id);
  var key = makeKeys(id);

  badiCalc.addTodayInfoToAnswers(profile, answers);
  addVerse(profile, answers);

  sendAllAnswers(`Reminder at ${serverWhen}`, answers, profile, key, null);
}

function getProfile(id) {
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
      console.log('Verses failed to load...');
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

function isAsking(question, text) {
  if (Array.isArray(text)) {
    for (var i = 0; i < text.length; i++) {
      if (isAsking(question, text[i])) {
        return true;
      }
    }
    return false;
  }
  //todo: need to avoid picking up keyword in the middle of another phrase?
  return question.toUpperCase().indexOf(text.toUpperCase()) !== -1;
}

function makeKeys(senderId) {
  return {
    profile: senderId + '_profile',
    log: senderId + '_log'
  };
}

function isDeveloperId(id) {
  var isDev = secrets.devId === id;
  if (!isDev) {
    console.log('!!! failed dev attempt from user id ' + id);
  }
  return isDev;
}

function notifyDeveloper(msg) {
  setTimeout(function (m) {
    var devId = secrets.devId;

    var devProfile = getProfile(devId);
    var keys = makeKeys(devId);
    //sendAllAnswers('new user', [m], devProfile, devId);
  }, 500, msg);

}

bot.on('error', (err) => {
  console.log(err.message)
})

prepareReminderTimer();
loadVersesAsync();

http.createServer(bot.middleware()).listen(1844);
