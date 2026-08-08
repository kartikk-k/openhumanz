-- Every calendar, by name.
--
-- argv: none

on run argv
	set names to {}
	set writables to {}
	tell application "Calendar"
		try
			set names to my asList(get name of calendars)
		end try
		try
			set writables to my asList(get writable of calendars)
		end try
	end tell

	set out to {}
	repeat with i from 1 to (count of names)
		set end of out to my jsonObject({my jsonField("name", my jsonString(my itemOr(names, i, ""))), my jsonField("writable", my jsonBool(my itemOr(writables, i, true)))})
	end repeat
	return my jsonObject({my jsonField("calendars", my jsonArray(out)), my jsonField("count", my jsonInt(count of names))})
end run
