-- Move a POSIX path to the Trash via Finder. Side-effecting.
--
-- argv:
--   1  POSIX path of the file or folder
--
-- Finder's `delete` sends the item to Trash; it does not empty the Trash and
-- this script never does. There is no empty-trash tool. The path arrives as
-- argv so it is never compiled into the source.

on run argv
	set posixPath to my argAt(argv, 1, "")
	if posixPath is "" then error "No path was supplied." number -1728

	tell application "Finder"
		try
			set theItem to (POSIX file posixPath) as alias
		on error
			error "The path does not exist." number -1728
		end try
		delete theItem
	end tell

	return my jsonObject({my jsonField("ok", my jsonBool(true)), my jsonField("path", my jsonString(posixPath))})
end run
