-- Events overlapping a date range.
--
-- argv:
--   1      calendar name  "" for every calendar
--   2      limit          default 50
--   3..8   range start    year month day hours minutes seconds
--   9..14  range end      year month day hours minutes seconds
--
-- Two things a caller must know and the result therefore states:
--
--  * **Recurring events are reported by their master, not their occurrences.**
--    Calendar.app's scripting interface has never expanded a recurrence into
--    per-date occurrences, so a weekly standup created last year does not appear
--    in next Tuesday's range. `recurrence` is returned so the caller can say so
--    rather than quietly showing an incomplete day.
--  * The date comparison is on `start date`, so an event that began before the
--    window and runs into it is not matched.
--
-- One Apple Event per matching event (`properties` fetches the whole record),
-- rather than one per property. The `whose` clause is a date comparison, which
-- Calendar evaluates against an index; content `whose` clauses are avoided here
-- for the same reason as in mail-search.

on run argv
	set calName to my argAt(argv, 1, "")
	set lim to my argInt(argv, 2, 50)
	if lim < 1 then set lim to 1
	set startD to my argDate(argv, 3, missing value)
	set endD to my argDate(argv, 9, missing value)
	if startD is missing value then set startD to (current date)
	if endD is missing value then set endD to startD + (7 * days)

	set out to {}
	set found to 0
	set hitLimit to false

	tell application "Calendar"
		set cals to {}
		if calName is "" then
			set cals to (every calendar)
		else
			try
				set cals to {calendar calName}
			end try
		end if
		repeat with c in cals
			if hitLimit then exit repeat
			set ownerName to ""
			try
				set ownerName to (name of c) as text
			end try
			set evts to {}
			try
				set evts to (every event of c whose start date is greater than or equal to startD and start date is less than endD)
			end try
			repeat with e in evts
				if found >= lim then
					set hitLimit to true
					exit repeat
				end if
				set p to missing value
				try
					set p to (properties of e)
				end try
				if p is not missing value then
					set found to found + 1
					set sm to ""
					set loc to ""
					set uidText to ""
					set startAt to missing value
					set endAt to missing value
					set allDay to false
					set recur to ""
					try
						set sm to (summary of p) as text
					end try
					try
						if (location of p) is not missing value then set loc to (location of p) as text
					end try
					try
						set uidText to (uid of p) as text
					end try
					try
						set startAt to (start date of p)
					end try
					try
						set endAt to (end date of p)
					end try
					try
						set allDay to (allday event of p)
					end try
					try
						if (recurrence of p) is not missing value then set recur to (recurrence of p) as text
					end try
					set end of out to my jsonObject({my jsonField("uid", my jsonString(uidText)), my jsonField("calendar", my jsonString(ownerName)), my jsonField("title", my jsonString(item 1 of (my clip(sm, 200)))), my jsonField("location", my jsonString(item 1 of (my clip(loc, 200)))), my jsonField("startsAt", my jsonDate(startAt)), my jsonField("endsAt", my jsonDate(endAt)), my jsonField("allDay", my jsonBool(allDay)), my jsonField("recurrence", my jsonString(item 1 of (my clip(recur, 200))))})
				end if
			end repeat
		end repeat
	end tell

	return my jsonObject({my jsonField("events", my jsonArray(out)), my jsonField("count", my jsonInt(found)), my jsonField("limitReached", my jsonBool(hitLimit)), my jsonField("recurringExpanded", my jsonBool(false)), my jsonField("rangeStart", my jsonDate(startD)), my jsonField("rangeEnd", my jsonDate(endD))})
end run
