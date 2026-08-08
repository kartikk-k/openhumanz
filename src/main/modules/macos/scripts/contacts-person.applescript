-- One contact by id.
--
-- argv:
--   1  person id
--   2  maxChars for the note field, default 1000

on run argv
	set wantId to my argAt(argv, 1, "")
	set maxChars to my argInt(argv, 2, 1000)
	if wantId is "" then return my jsonObject({my jsonField("found", my jsonBool(false))})

	set nm to ""
	set og to ""
	set jobTitle to ""
	set noteText to ""
	set emails to {}
	set phones to {}
	set found to false

	tell application "Contacts"
		set p to missing value
		try
			set p to (first person whose id is wantId)
		end try
		if p is not missing value then
			set found to true
			try
				set nm to (name of p) as text
			end try
			try
				if (organization of p) is not missing value then set og to (organization of p) as text
			end try
			try
				if (job title of p) is not missing value then set jobTitle to (job title of p) as text
			end try
			try
				if (note of p) is not missing value then set noteText to (note of p) as text
			end try
			try
				set emails to my asList(get value of emails of p)
			end try
			try
				set phones to my asList(get value of phones of p)
			end try
		end if
	end tell

	if found is false then return my jsonObject({my jsonField("found", my jsonBool(false))})

	set noteClip to my clip(noteText, maxChars)
	return my jsonObject({my jsonField("found", my jsonBool(true)), my jsonField("id", my jsonString(wantId)), my jsonField("name", my jsonString(item 1 of (my clip(nm, 200)))), my jsonField("organization", my jsonString(item 1 of (my clip(og, 200)))), my jsonField("jobTitle", my jsonString(item 1 of (my clip(jobTitle, 200)))), my jsonField("emails", my jsonStringArray(emails)), my jsonField("phones", my jsonStringArray(phones)), my jsonField("note", my jsonString(item 1 of noteClip)), my jsonField("noteTruncated", my jsonBool(item 2 of noteClip))})
end run
