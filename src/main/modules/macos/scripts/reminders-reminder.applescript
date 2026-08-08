-- One reminder by id.
--
-- argv:
--   1  reminder id
--   2  maxChars for the body, default 2000

on run argv
	set wantId to my argAt(argv, 1, "")
	set maxChars to my argInt(argv, 2, 2000)
	if wantId is "" then return my jsonObject({my jsonField("found", my jsonBool(false))})

	set found to false
	set nm to ""
	set bodyText to ""
	set isDone to false
	set dueAt to missing value
	set remindAt to missing value
	set prio to 0
	set ownerName to ""

	tell application "Reminders"
		set r to missing value
		try
			set r to (first reminder whose id is wantId)
		end try
		if r is not missing value then
			set found to true
			try
				set nm to (name of r) as text
			end try
			try
				if (body of r) is not missing value then set bodyText to (body of r) as text
			end try
			try
				set isDone to (completed of r)
			end try
			try
				set dueAt to (due date of r)
			end try
			try
				set remindAt to (remind me date of r)
			end try
			try
				set prio to (priority of r)
			end try
			try
				set ownerName to (name of (container of r)) as text
			end try
		end if
	end tell

	if found is false then return my jsonObject({my jsonField("found", my jsonBool(false))})

	set bodyClip to my clip(bodyText, maxChars)
	return my jsonObject({my jsonField("found", my jsonBool(true)), my jsonField("id", my jsonString(wantId)), my jsonField("list", my jsonString(ownerName)), my jsonField("title", my jsonString(item 1 of (my clip(nm, 200)))), my jsonField("completed", my jsonBool(isDone)), my jsonField("dueAt", my jsonDate(dueAt)), my jsonField("remindAt", my jsonDate(remindAt)), my jsonField("priority", my jsonInt(prio)), my jsonField("body", my jsonString(item 1 of bodyClip)), my jsonField("bodyTruncated", my jsonBool(item 2 of bodyClip))})
end run
