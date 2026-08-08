-- Create a note. Side-effecting; routed through the approval gate.
--
-- argv:
--   1  title
--   2  body (plain text)
--   3  folder name, "" for the default folder
--
-- The body is escaped into an HTML paragraph on the way in: Notes interprets
-- `body` as HTML, so text carrying `<` or `&` -- which is any text quoted from
-- an email -- would otherwise be silently mangled or, worse, inject markup.

on run argv
	set titleText to my argAt(argv, 1, "")
	set bodyText to my argAt(argv, 2, "")
	set folderName to my argAt(argv, 3, "")

	set htmlBody to "<div><b>" & my htmlEscape(titleText) & "</b></div><div>" & my htmlEscape(bodyText) & "</div>"

	set createdId to ""
	tell application "Notes"
		set target to missing value
		if folderName is not "" then
			try
				set target to folder folderName
			end try
		end if
		if target is missing value then
			set newNote to make new note with properties {name:titleText, body:htmlBody}
		else
			set newNote to make new note at target with properties {name:titleText, body:htmlBody}
		end if
		try
			set createdId to (id of newNote) as text
		end try
	end tell

	return my jsonObject({my jsonField("ok", my jsonBool(true)), my jsonField("id", my jsonString(createdId)), my jsonField("title", my jsonString(titleText))})
end run

on htmlEscape(t)
	if t is missing value then return ""
	set s to t as text
	set acc to {}
	repeat with ch in (characters of s)
		set c to (contents of ch)
		if c is "&" then
			set end of acc to "&amp;"
		else if c is "<" then
			set end of acc to "&lt;"
		else if c is ">" then
			set end of acc to "&gt;"
		else if c is "\"" then
			set end of acc to "&quot;"
		else if c is "'" then
			set end of acc to "&#39;"
		else if (id of c) = 10 then
			set end of acc to "<br>"
		else if (id of c) = 13 then
			set end of acc to ""
		else
			set end of acc to c
		end if
	end repeat
	return my joinText(acc, "")
end htmlEscape
