/**
 * Google Apps Script — run this from the Google account that OWNS the school
 * calendars (schedule@ymu.org).
 *
 * It does two things in one pass, for every calendar that account owns:
 *   1. Grants the YMU-A sync service account read access (idempotent).
 *   2. Writes a JSON file to Drive listing every calendar's id and name.
 *
 * Both steps are needed and neither replaces the other. Sharing a calendar
 * with a service account grants real ACL access immediately, but does NOT put
 * the calendar in the service account's own calendarList — a service account
 * has no inbox and no UI to "accept" a share the way a person does. The YMU-A
 * sync discovers calendars by reading calendarList, so a shared-but-not-
 * subscribed calendar stays invisible to it. The JSON this produces is the
 * input to scripts/subscribe-calendars.ts, which performs that subscription.
 *
 * SETUP (once):
 *   1. Go to script.google.com, signed in as the calendar-owning account.
 *   2. New project. Paste this whole file in, replacing the default code.
 *   3. In the left sidebar click Services (+), choose "Google Calendar API",
 *      and click Add. The advanced service must be on — CalendarApp alone
 *      cannot write ACL rules.
 *   4. Select shareAndListCalendars in the function dropdown, click Run, and
 *      approve the permission prompt.
 *
 * The run log prints a summary. The JSON lands in the account's Drive root as
 * ymu-calendar-ids.json — download it and hand it to the sync step.
 *
 * Re-running is safe: granting an ACL rule that already exists is a no-op, and
 * the Drive file is overwritten rather than duplicated.
 */

var SERVICE_ACCOUNT_EMAIL =
  'ymu-calendar-sync@cosmic-antenna-502619-u6.iam.gserviceaccount.com';

var OUTPUT_FILENAME = 'ymu-calendar-ids.json';

function shareAndListCalendars() {
  var calendars = CalendarApp.getAllOwnedCalendars();
  var entries = [];
  var granted = 0;
  var skipped = 0;
  var failed = 0;

  for (var i = 0; i < calendars.length; i++) {
    var calendar = calendars[i];
    var id = calendar.getId();
    var name = calendar.getName();

    // The account's own primary calendar is not a school. Left in, it reaches
    // the sync as an unmatchable calendar and parks a pointless row in the
    // calendar_sync_issues queue for someone to dismiss by hand.
    if (id === Session.getEffectiveUser().getEmail()) {
      skipped++;
      continue;
    }

    // 'reader' is deliberate — the sync only ever reads events. Never grant
    // writer/owner to an automated account that does not need it.
    //
    // Acl.insert is an upsert: re-inserting an identical rule succeeds rather
    // than raising, so `granted` counts calendars processed, not newly changed
    // ones. The catch is for real failures (a calendar the account can no
    // longer administer), which is why one is not fatal to the rest of the run.
    try {
      Calendar.Acl.insert(
        { role: 'reader', scope: { type: 'user', value: SERVICE_ACCOUNT_EMAIL } },
        id
      );
      granted++;
    } catch (e) {
      failed++;
      Logger.log('FAILED to share "' + name + '" (' + id + '): ' + String(e));
    }

    entries.push({ id: id, name: name });
  }

  writeJsonToDrive(OUTPUT_FILENAME, entries);

  Logger.log('');
  Logger.log('Calendars owned by this account : ' + calendars.length);
  Logger.log('Shared with the service account : ' + granted);
  Logger.log('Skipped (own primary calendar)  : ' + skipped);
  Logger.log('Failed to share                 : ' + failed);
  Logger.log('');
  Logger.log('Wrote ' + OUTPUT_FILENAME + ' (' + entries.length + ' calendars) to this account\'s Drive.');
  Logger.log('');
  Logger.log('NOTE: this only covers calendars this account OWNS. A calendar');
  Logger.log('owned by someone else must be run from that owner\'s account, or');
  Logger.log('its owner must share it with the service account by hand.');
}

/**
 * Overwrites the file if it already exists, so repeated runs leave one file
 * rather than a pile of same-named copies (Drive allows duplicate names).
 *
 * HELPER — do not select this in the Run dropdown. Apps Script passes no
 * arguments to a directly-run function, so `filename` arrives undefined and
 * getFilesByName throws "Invalid argument: name". Run shareAndListCalendars.
 */
function writeJsonToDrive(filename, data) {
  var json = JSON.stringify(data, null, 2);
  var existing = DriveApp.getFilesByName(filename);
  if (existing.hasNext()) {
    existing.next().setContent(json);
  } else {
    DriveApp.createFile(filename, json, MimeType.PLAIN_TEXT);
  }
}

/**
 * Optional: run this first to see what would happen without changing any
 * sharing. Lists the calendars and whether the service account can already
 * read them.
 */
function dryRunListCalendars() {
  var calendars = CalendarApp.getAllOwnedCalendars();
  Logger.log('Calendars owned by this account: ' + calendars.length);
  for (var i = 0; i < calendars.length; i++) {
    var id = calendars[i].getId();
    var shared = false;
    try {
      var rules = Calendar.Acl.list(id);
      var items = rules.items || [];
      for (var j = 0; j < items.length; j++) {
        if (items[j].scope && items[j].scope.value === SERVICE_ACCOUNT_EMAIL) {
          shared = true;
          break;
        }
      }
    } catch (e) {
      Logger.log('  (could not read ACL for ' + id + ')');
    }
    Logger.log((shared ? '[shared]    ' : '[NOT shared]') + ' ' + calendars[i].getName());
  }
}
