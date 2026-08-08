-- One event by uid.
--
-- argv:
--   1  uid
--   2  maxChars for the description, default 2000

on run argv
	set wantUid to my argAt(argv, 1, "")
	set maxChars to my argInt(argv, 2, 2000)
	if wantUid is "" then return my jsonObject({my jsonField("found", my jsonBool(false))})

	set p to missing value
	set ownerName to ""
	tell application "Calendar"
		repeat with c in (every calendar)
			if p is not missing value then exit repeat
			set candidate to missing value
			try
				set candidate to (first event of c whose uid is wantUid)
			end try
			if candidate is not missing value then
				try
					set ownerName to (name of c) as text
				end try
				try
					set p to (properties of candidate)
				end try
			end if
		end repeat
	end tell

	if p is missing value then return my jsonObject({my jsonField("found", my jsonBool(false))})

	set sm to ""
	set loc to ""
	set notesText to ""
	set startAt to missing value
	set endAt to missing value
	set allDay to false
	set recur to ""
	try
		set sm to (summary of p) as text
	end try
	try
		if (location of p) is not missing value then set loc to (location of p) as text
	end try
	try
		if (description of p) is not missing value then set notesText to (description of p) as text
	end try
	try
		set startAt to (start date of p)
	end try
	try
		set endAt to (end date of p)
	end try
	try
		set allDay to (allday event of p)
	end try
	try
		if (recurrence of p) is not missing value then set recur to (recurrence of p) as text
	end try

	set notesClip to my clip(notesText, maxChars)
	return my jsonObject({my jsonField("found", my jsonBool(true)), my jsonField("uid", my jsonString(wantUid)), my jsonField("calendar", my jsonString(ownerName)), my jsonField("title", my jsonString(item 1 of (my clip(sm, 300)))), my jsonField("location", my jsonString(item 1 of (my clip(loc, 300)))), my jsonField("startsAt", my jsonDate(startAt)), my jsonField("endsAt", my jsonDate(endAt)), my jsonField("allDay", my jsonBool(allDay)), my jsonField("recurrence", my jsonString(item 1 of (my clip(recur, 200)))), my jsonField("notes", my jsonString(item 1 of notesClip)), my jsonField("notesTruncated", my jsonBool(item 2 of notesClip))})
end run
