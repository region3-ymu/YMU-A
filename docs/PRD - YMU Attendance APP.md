**PRD \- YMU Attendance APP**

An app titled “YMU-A” allows for more than \~100 Music Teachers to track their attendance by clocking in and out from at most \~255 schools at YMU. Young Musicians Unite is a non-profit organization based in Miami-Dade County that gives young musicians a voice through music programs across dozens of schools.

**Requirements:**  
Logs attendance and schedule (Allows clocking in and out) of various employees.   
Must support max \~255 locations for geofencing and tracking \~100+ employees. **Geofence distance must be 200 meters away.**  
(After clocking in, your GPS is secretly checked **5 times** with an interval of 5 minutes each, the teacher must remain in the geofence in all of these checks or they are automatically flagged for Regional Managers)  
Employees must be in the geofence to clock in  
Connect to a google calendar full of teacher and school schedules via API.  
Allows employees to view their subject (Beginning band, Pitch & Rhythm, etc..) and their whole schedule by school and times.  
Must leave push notifications or SMS messages to nudge employees that they should be at their location. (\~15 minutes before)   
If they are late, provide managers a list of steps to do, first call the teacher, then the school with numbers of both.  
Mandates for a form to be filled after every shift for class feedback before clocking out. \*  
Supports offline usage.   
Provides reports per teacher on their attendance (summaries of worked hours, attendance rates and percentages, weekly, monthly, every 9 weeks/quarter)

**Specifics:**  
Must be a PWA web-app with the main use of adding it to a homescreen on all phones to appear as an app.  
Must connect to a suggested free database with ALL the information stored there.  
Intended to host for free if possible.  
Allow for new schools to be added by address and name: each individual school is geocoded once to find longitude and latitude.  
The app MUST be able to get gps data from phones\!  
The haversine formula is used to determine the distance between a school and a teacher such that you are only able to clock in within a certain distance from the school.  
You are only able to clock out once a Zoho feedback form is provided and it is checked that you submit it on Zoho. If declined, you are not able to clock in any class unless you submit the form in your Demands list.  
All APIs and features must be free if possible.

The app has a login/signup system (with email verification), where you must provide your teacher contact email, phone number, full name, and password to sign up as a teacher. And an Operations Manager Account that is going to be the one that can promote an account to a different role like a Regional Manager and is going to have full name, phone number, email, password. A CPO account is only set once in the database manually. The login only prompts the email and password.

The app has various menus, including Clocking, Schedules, Reports, Settings. The manager version will replace Clocking with Lists. 

Clocking: Shows your next session/class listed in your schedule and at what time to enter and leave, date, and location. A large Clock-in button is there to be pressed, which then pulls the GPS information of the user to check if the device is in range. A built-in map is then shown with your location the instance you pressed the button and tells you if you are in or out of range. In range and it lets you clock in with the precise clock in time, and out of range tells you to be closer and try clocking in again. A Clock-out button shows afterwards to mark that class is done. You do not need geolocation for clocking out, however, a webhook of a Zoho feedback form is given that is MANDATORY to fill out. The app checks if it is completed and lets you Clock in for the next class. If not filled out, there is no way to exit the form webhook, even if logged out, logging back in will prompt the user until they finish.

Summary:  
When Clock-In is pressed, the app retrieves the user's GPS location.  
A map displays the teacher's location, school location, and geofence distance.  
The app calculates distance using the Haversine formula.  
Clock-in is allowed only when inside the configured geofence radius.  
If outside the radius, clock-in is denied and the teacher must move closer and retry.  
GPS verification only occurs during clock-in; continuous tracking is not used.

Schedules: Shows the calendar of your classes and times to teach in schools. Synced to an existing Google Calendar. If there are changes in the calendar for email or teacher or substitute, it will automatically pair to the app, it will let relevant teachers know via push-notification that their schedule is changed or removed. There are emails in the google calendar events that correspond to each teacher, the app should link those emails to the emails of the login information to link and assign teachers. Teachers only see their own schedule. There are various class types that some teachers specialize in. The schedule shows if you are in the middle of a teaching shift. Teachers may have to teach at different schools in different time frames.

Summary:  
Google Calendar is the source of truth for all schedules.  
Schedule creation, edits, teacher assignments, and substitutions happen directly in Google Calendar.  
The app only syncs calendar data through API.  
Changes to teachers, substitutes, locations, times, or removed events automatically update the app.  
Relevant users receive push notifications for schedule changes, new assignments, or removed classes.

Reports: Can generate a self-report on the hours worked weekly, monthly, and every 9 weeks/quarter since that school started class. Also include extra information in the report to be downloaded by the teacher. Regional Managers have their own version that allows them to choose which teacher they can get the report from. Only the Operations Manager and CPO can make a master report of ALL teachers of all the regions, inside the report is a combination of all teachers and all teachers separated.

Settings can change settings of the app, like a dark mode, and if they do not want notifications (they MUST be sure they don't want it, it is on by default, and you must prompt to make sure they are absolutely sure and are responsible for late times \[“Responsibility Checks”\]) Notifications before class can have adjustable times other than 15 minutes before. Different notifications can have different on off settings, like a reminder to clock in, reminder to be early, reminder to clock out, all responsibility checks before you turn it off apply here as well.

* Notifications are push-notifs sent to the phone that tell you that you need to go to a class soon.  
* Regional Managers instead will be able to see ALL teachers schedules, and teachers individually by region (Central, East, West, North, South)  
* Regional Managers can edit lists in the Lists tab, they can add new schools, they can not change regions once a school has been assigned, control and see what teachers are in there (It will show if they are in the shift), and ONLY be able to view CPO and Operational Managers, not edit. Clicking on teachers will show their name, email, and phone number. Clicking on an event in the google calendar schedule, regardless of role, will show the same information that clicking on it in google calendar would.  
* CPO and Operational Managers can assign each school to categorical regions above for the different regional managers.  
* Regional Managers, CPOs, and Operational Managers have their own versions of the app, with a different main color to distinguish them.  
* The APP is intended to be viewed on a smartphone, so ensure UI compatibility.  
* The database must have an empty CPO and operational manager roles such that it can be assigned later on in the database.

## **1\. User Roles and Permissions**

* Define permissions for Teacher, Regional Manager, Operations Manager, and CPO accounts.  
* Teachers manage only their own schedules, attendance, reports, and feedback.  
* Regional Managers manage teachers and schools within their assigned region.  
* Operations Managers and CPOs have organization-wide management access.  
* CPO and Operations Manager accounts cannot be edited by Regional Managers.

---

## **2\. Attendance Clock Rules**

* Define attendance status based on clock-in time.  
* Early clock-in window should be configurable.  
* Default on-time window: within ±5 minutes of scheduled class time.  
* After 5 minutes, you are marked Late.  
* Reports must calculate attendance percentages based on these rules.

---

## **3\. GPS Permission Handling**

* Location permission is required to clock in.  
* If GPS permission is denied, clock-in is blocked.  
* The app must handle disabled GPS, inaccurate GPS, and location errors.  
* Users should be prompted to retry location verification.

---

## **4\. Notification Backup**

* Push notifications are the primary notification method.  
* Email notifications are used as a backup for important reminders.  
* Email notifications include schedule changes, class cancellations, and clock-out reminders.

---

## **5\. Notification Types**

* Schedule changed notifications.  
* Class cancelled notifications.  
* Clock-out reminder notifications.  
* Users can manage notification settings with responsibility confirmations.

---

## **6\. School Contact Information**

Each school record must include:

* School name.  
* Address.  
* Contact person name.  
* Contact person phone number.  
* GPS coordinates from geocoding. (Automatically generated with API after inserting address)

---

## **7\. Teacher Profile Information**

Teacher profiles must include:

* Full name.  
* Email.  
* Phone number.  
* Subjects/specializations.  
* Assigned regions.  
* Emergency contact information.

---

## **8\. School Year Management**

* Support multiple school years.  
* Attendance and schedules must be linked to a school year.  
* Previous school years must remain available for reports.  
* Completed school years can be archived.

---

## **9\. Account Archiving**

* Users should be archived instead of deleted.  
* Archived teachers cannot receive schedules or clock in.  
* Historical attendance data must remain available.  
* Archived teachers will have their own section in the master report.

---

## **10\. Data Export**

Authorized users can export:

* Attendance reports.  
* Teacher reports.  
* Organization reports.

Supported formats:

* CSV.  
* PDF.

---

## **11\. Search Functionality**

Managers can search:

* Teachers.  
* Schools.  
* Attendance records.  
* Reports.  
* Calendar events.

---

## **12\. Manager Dashboard**

Managers should have a dashboard showing:

* Teachers scheduled today.  
* Teachers currently clocked in.  
* Late teachers.  
* Missing clock-ins.  
* Pending feedback forms.  
* Upcoming classes.

---

## **13\. Offline Mode and Synchronization**

* The app supports limited offline functionality.  
* Previously synced schedules remain accessible offline.  
* Clock-in attempts made offline are stored locally.  
* Attendance data automatically syncs when internet connection returns.  
* Duplicate attendance records must be prevented during synchronization.

---

## **14\. Error Handling**

The app must handle:

* Google Calendar synchronization errors.  
* Zoho form failures.  
* GPS failures.  
* Database connection errors.  
* Notification failures.  
* Internet connectivity issues.

Users should receive clear error messages and next steps.

---

## **15\. Security Requirements**

The system must include:

* Secure password storage.  
* HTTPS communication.  
* Authentication protection.  
* Session expiration.  
* Password reset functionality.  
* Role-based access control.

---

## **16\. Performance and Reliability Requirements**

The app should:

* Support 500+ users.  
* Support at least 255 school locations.  
* Be optimized for mobile PWA usage.  
* Load quickly on mobile networks.  
* Complete GPS verification efficiently.  
* Maintain reliability during school operating hours.  
* Protect stored attendance data.

  