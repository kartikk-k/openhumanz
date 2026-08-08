-- Create an event. Side-effecting; routed through the approval gate.
--
-- argv:
--   1      calendar name  "" for the first writable calendar
--   2      title
--   3      location
--   4      notes
--   5      allDay         "1" or "0"
--   6..11  start          year month day hours minutes seconds
--   12..17 end            year month day hours minutes seconds
--
-- No invitations are sent and no attendees are added: `make new attendee`
-- triggers Calendar to mail every one of them the moment the event is saved,
-- which is an outbound message the user never approved. Attendees stay a manual
-- step.

on run argv
	set calName to my argAt(argv, 1, "")
	set titleText to my argAt(argv, 2, "")
	set locText to my argAt(argv, 3, "")
	set notesText to my argAt(argv, 4, "")
	set allDay to my argBool(argv, 5, false)
	set startD to my argDate(argv, 6, missing value)
	set endD to my argDate(argv, 12, missing value)
	if startD is missing value then set startD to (current date)
	if endD is missing value then set endD to startD + (60 * 60)

	set createdUid to ""
	set ownerName to ""
	tell application "Calendar"
		set target to missing value
		if calName is not "" then
			try
				set target to calendar calName
			end try
		end if
		if target is missing value then
			repeat with c in (every calendar)
				if target is missing value then
					try
						if (writable of c) then set target to contents of c
					end try
				end if
			end repeat
		end if
		if target is missing value then error "No writable calendar is available." number -1728
		set ownerName to (name of target) as text
		set newEvent to make new event at end of events of target with properties {summary:titleText, start date:startD, end date:endD, allday event:allDay}
		if locText is not "" then
			try
				set location of newEvent to locText
			end try
		end if
		if notesText is not "" then
			try
				set description of newEvent to notesText
			end try
		end if
		try
			set createdUid to (uid of newEvent) as text
		end try
	end tell

	return my jsonObject({my jsonField("ok", my jsonBool(true)), my jsonField("uid", my jsonString(createdUid)), my jsonField("calendar", my jsonString(ownerName)), my jsonField("startsAt", my jsonDate(startD)), my jsonField("endsAt", my jsonDate(endD))})
end run
