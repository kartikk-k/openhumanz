-- Search contacts by name, organisation or email address.
--
-- argv:
--   1  query
--   2  limit       default 20
--   3  scanLimit   maximum people inspected, default 2000
--
-- Contacts holds thousands of records and `people whose name contains x` is a
-- linear scan inside the app. Four bulk property reads -- including the nested
-- `value of emails of people`, which comes back as one list-of-lists in a single
-- Apple Event -- plus local filtering costs four round trips for the whole
-- address book instead of four per person. Phone numbers are fetched only for
-- records that already matched, because they are needed for at most `limit`
-- rows.

on run argv
	set qy to my argAt(argv, 1, "")
	set lim to my argInt(argv, 2, 20)
	set scanLimit to my argInt(argv, 3, 2000)
	if lim < 1 then set lim to 1

	set out to {}
	set found to 0
	set scanned to 0

	tell application "Contacts"
		set ids to {}
		set names to {}
		set orgs to {}
		set emailLists to {}
		try
			set ids to my asList(get id of people)
			set names to my asList(get name of people)
			set orgs to my asList(get organization of people)
		end try
		try
			set emailLists to my asList(get value of emails of people)
		end try

		set n to (count of ids)
		if n > scanLimit then set n to scanLimit
		repeat with i from 1 to n
			if found >= lim then exit repeat
			set scanned to scanned + 1
			set nm to my itemOr(names, i, "")
			set og to my itemOr(orgs, i, "")
			set emails to my asList(my itemOr(emailLists, i, {}))

			set keep to false
			if qy is "" then
				set keep to true
			else if my containsCI(nm, qy) then
				set keep to true
			else if my containsCI(og, qy) then
				set keep to true
			else
				repeat with e in emails
					if my containsCI((contents of e) as text, qy) then set keep to true
				end repeat
			end if

			if keep then
				set found to found + 1
				set personId to my itemOr(ids, i, "")
				set phones to {}
				if personId is not "" then
					try
						set phones to my asList(get value of phones of (first person whose id is personId))
					end try
				end if
				set end of out to my jsonObject({my jsonField("id", my jsonString(personId)), my jsonField("name", my jsonString(item 1 of (my clip(nm, 200)))), my jsonField("organization", my jsonString(item 1 of (my clip(og, 200)))), my jsonField("emails", my jsonStringArray(emails)), my jsonField("phones", my jsonStringArray(phones))})
			end if
		end repeat
	end tell

	return my jsonObject({my jsonField("contacts", my jsonArray(out)), my jsonField("count", my jsonInt(found)), my jsonField("scanned", my jsonInt(scanned))})
end run
