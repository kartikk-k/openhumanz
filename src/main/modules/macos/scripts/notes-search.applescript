-- Search Notes titles, and optionally bodies.
--
-- argv:
--   1  query
--   2  limit        default 20
--   3  folder name  "" for every folder
--   4  scanLimit    maximum notes inspected, default 500
--   5  searchBodies "1" to also match the plaintext body
--
-- Bodies are opt-in and cost one Apple Event per note. Notes stores bodies as
-- HTML and `plaintext` is the only property that is not full markup; pulling
-- every body eagerly on an account with a few hundred notes is seconds of wall
-- clock, so title-and-name matching is the default and the caller opts in when
-- the user actually asked to search inside notes.

on run argv
	set qy to my argAt(argv, 1, "")
	set lim to my argInt(argv, 2, 20)
	set folderName to my argAt(argv, 3, "")
	set scanLimit to my argInt(argv, 4, 500)
	set searchBodies to my argBool(argv, 5, false)
	if lim < 1 then set lim to 1

	set out to {}
	set found to 0
	set scanned to 0

	tell application "Notes"
		set ids to {}
		set names to {}
		set modDates to {}
		if folderName is "" then
			try
				set ids to my asList(get id of notes)
				set names to my asList(get name of notes)
				set modDates to my asList(get modification date of notes)
			end try
		else
			try
				set ids to my asList(get id of notes of folder folderName)
				set names to my asList(get name of notes of folder folderName)
				set modDates to my asList(get modification date of notes of folder folderName)
			end try
		end if

		set n to (count of ids)
		if n > scanLimit then set n to scanLimit
		repeat with i from 1 to n
			if found >= lim then exit repeat
			set scanned to scanned + 1
			set nm to my itemOr(names, i, "")
			set noteId to my itemOr(ids, i, "")
			set snippet to ""
			set keep to false
			if qy is "" then
				set keep to true
			else if my containsCI(nm, qy) then
				set keep to true
			end if

			if (keep is false) and searchBodies and (noteId is not "") then
				set bodyText to ""
				try
					set bodyText to (plaintext of (first note whose id is noteId)) as text
				end try
				if my containsCI(bodyText, qy) then
					set keep to true
					set snippet to item 1 of (my clip(bodyText, 200))
				end if
			end if

			if keep then
				set found to found + 1
				set end of out to my jsonObject({my jsonField("id", my jsonString(noteId)), my jsonField("title", my jsonString(item 1 of (my clip(nm, 200)))), my jsonField("modifiedAt", my jsonDate(my itemOr(modDates, i, missing value))), my jsonField("snippet", my jsonString(snippet))})
			end if
		end repeat
	end tell

	return my jsonObject({my jsonField("notes", my jsonArray(out)), my jsonField("count", my jsonInt(found)), my jsonField("scanned", my jsonInt(scanned)), my jsonField("bodiesSearched", my jsonBool(searchBodies))})
end run
