-- One note by id, as plaintext.
--
-- argv:
--   1  note id
--   2  maxChars, default 4000
--
-- `plaintext` rather than `body`: `body` is HTML and handing raw markup to the
-- model costs tokens for tags and invites prompt injection through attributes.

on run argv
	set wantId to my argAt(argv, 1, "")
	set maxChars to my argInt(argv, 2, 4000)
	if wantId is "" then return my jsonObject({my jsonField("found", my jsonBool(false))})

	set found to false
	set nm to ""
	set bodyText to ""
	set modAt to missing value
	set createdAt to missing value

	tell application "Notes"
		set nt to missing value
		try
			set nt to (first note whose id is wantId)
		end try
		if nt is not missing value then
			set found to true
			try
				set nm to (name of nt) as text
			end try
			try
				set bodyText to (plaintext of nt) as text
			end try
			try
				set modAt to (modification date of nt)
			end try
			try
				set createdAt to (creation date of nt)
			end try
		end if
	end tell

	if found is false then return my jsonObject({my jsonField("found", my jsonBool(false))})

	set bodyClip to my clip(bodyText, maxChars)
	return my jsonObject({my jsonField("found", my jsonBool(true)), my jsonField("id", my jsonString(wantId)), my jsonField("title", my jsonString(item 1 of (my clip(nm, 200)))), my jsonField("createdAt", my jsonDate(createdAt)), my jsonField("modifiedAt", my jsonDate(modAt)), my jsonField("body", my jsonString(item 1 of bodyClip)), my jsonField("bodyTruncated", my jsonBool(item 2 of bodyClip))})
end run
