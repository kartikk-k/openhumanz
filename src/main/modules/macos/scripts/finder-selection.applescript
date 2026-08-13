-- What is currently selected in Finder, and the front window's folder.
--
-- argv:
--   1  limit, default 50
--
-- Read-only and non-launching: Finder is always running, so this cannot start
-- an app behind the user's back. The other Finder verb on this surface is
-- trash (`finder-trash`); empty-trash is deliberately absent. Text I/O uses
-- Node fs, not AppleScript.

on run argv
	set lim to my argInt(argv, 1, 50)
	if lim < 1 then set lim to 1

	set paths to {}
	set names to {}
	set windowPath to ""

	tell application "Finder"
		try
			set sel to (get selection)
			set n to (count of sel)
			if n > lim then set n to lim
			repeat with i from 1 to n
				set itemRef to item i of sel
				try
					set end of paths to (POSIX path of (itemRef as alias))
				end try
				try
					set end of names to (name of itemRef) as text
				end try
			end repeat
		end try
		try
			set windowPath to (POSIX path of (target of front Finder window as alias))
		end try
	end tell

	set out to {}
	repeat with i from 1 to (count of paths)
		set end of out to my jsonObject({my jsonField("path", my jsonString(my itemOr(paths, i, ""))), my jsonField("name", my jsonString(my itemOr(names, i, "")))})
	end repeat

	return my jsonObject({my jsonField("selection", my jsonArray(out)), my jsonField("count", my jsonInt(count of paths)), my jsonField("frontWindowPath", my jsonString(windowPath))})
end run
