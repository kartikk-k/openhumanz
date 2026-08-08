-- Reminders in one list, or across every list.
--
-- argv:
--   1  list name         "" for every list
--   2  limit             default 50
--   3  includeCompleted  "1" to include completed reminders
--
-- Four bulk property reads per list. `completed` is filtered here rather than
-- with a `whose` clause so the same code path serves both settings and so the
-- count of what was skipped is reportable.

on run argv
	set listName to my argAt(argv, 1, "")
	set lim to my argInt(argv, 2, 50)
	set includeCompleted to my argBool(argv, 3, false)
	if lim < 1 then set lim to 1

	set out to {}
	set found to 0
	set skippedCompleted to 0
	set listNames to {}

	tell application "Reminders"
		set targets to {}
		if listName is "" then
			set targets to (every list)
		else
			try
				set targets to {list listName}
			end try
		end if

		repeat with L in targets
			if found >= lim then exit repeat
			set ownerName to ""
			try
				set ownerName to (name of L) as text
			end try
			set end of listNames to ownerName

			set ids to {}
			set names to {}
			set dones to {}
			set dueDates to {}
			set prios to {}
			try
				set ids to my asList(get id of reminders of L)
				set names to my asList(get name of reminders of L)
				set dones to my asList(get completed of reminders of L)
				set dueDates to my asList(get due date of reminders of L)
				set prios to my asList(get priority of reminders of L)
			end try

			repeat with i from 1 to (count of ids)
				if found >= lim then exit repeat
				set isDone to my itemOr(dones, i, false)
				if isDone and (includeCompleted is false) then
					set skippedCompleted to skippedCompleted + 1
				else
					set found to found + 1
					set end of out to my jsonObject({my jsonField("id", my jsonString((my itemOr(ids, i, "")) as text)), my jsonField("list", my jsonString(ownerName)), my jsonField("title", my jsonString(item 1 of (my clip(my itemOr(names, i, ""), 200)))), my jsonField("completed", my jsonBool(isDone)), my jsonField("dueAt", my jsonDate(my itemOr(dueDates, i, missing value))), my jsonField("priority", my jsonInt(my itemOr(prios, i, 0)))})
				end if
			end repeat
		end repeat
	end tell

	return my jsonObject({my jsonField("reminders", my jsonArray(out)), my jsonField("count", my jsonInt(found)), my jsonField("skippedCompleted", my jsonInt(skippedCompleted)), my jsonField("lists", my jsonStringArray(listNames))})
end run
