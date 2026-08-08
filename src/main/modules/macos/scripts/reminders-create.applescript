-- Create a reminder. Side-effecting; routed through the approval gate.
--
-- argv:
--   1      list name  "" for the default list
--   2      title
--   3      body
--   4..9   due date   year month day hours minutes seconds, first slot 0 for none

on run argv
	set listName to my argAt(argv, 1, "")
	set titleText to my argAt(argv, 2, "")
	set bodyText to my argAt(argv, 3, "")
	set dueAt to my argDate(argv, 4, missing value)

	set createdId to ""
	set ownerName to ""
	tell application "Reminders"
		set target to missing value
		if listName is not "" then
			try
				set target to list listName
			end try
		end if
		if target is missing value then
			try
				set target to default list
			end try
		end if
		if target is missing value then error "No reminders list is available." number -1728
		set ownerName to (name of target) as text

		if dueAt is missing value then
			set newReminder to make new reminder at end of reminders of target with properties {name:titleText}
		else
			set newReminder to make new reminder at end of reminders of target with properties {name:titleText, due date:dueAt, remind me date:dueAt}
		end if
		if bodyText is not "" then
			try
				set body of newReminder to bodyText
			end try
		end if
		try
			set createdId to (id of newReminder) as text
		end try
	end tell

	return my jsonObject({my jsonField("ok", my jsonBool(true)), my jsonField("id", my jsonString(createdId)), my jsonField("list", my jsonString(ownerName)), my jsonField("title", my jsonString(titleText)), my jsonField("dueAt", my jsonDate(dueAt))})
end run
