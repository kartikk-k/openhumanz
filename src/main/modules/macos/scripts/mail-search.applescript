-- Search a mailbox by scanning a bounded window of recent messages.
--
-- argv:
--   1  query          matched case-insensitively against subject and sender
--   2  mailbox name   default "INBOX"
--   3  account name   "" for every account
--   4  limit          maximum hits returned, default 20
--   5  unreadOnly     "1" to keep only unread
--   6  scanLimit      maximum messages inspected across all mailboxes, default 300
--
-- Why a bounded scan rather than a `whose` clause: Mail's `whose` filtering on
-- content is evaluated inside Mail, takes minutes on a large mailbox and has
-- regressed repeatedly across releases. Pulling five parallel property lists in
-- five Apple Events and filtering here is O(1) in round trips and predictable in
-- wall clock, which is what a hard timeout needs. The cost is that this searches
-- the most recent `scanLimit` messages, not the whole mailbox -- so the result
-- reports `scanned` and `truncated` and the caller must not present it as an
-- exhaustive search.

on run argv
	set qy to my argAt(argv, 1, "")
	set mboxName to my argAt(argv, 2, "INBOX")
	set acctName to my argAt(argv, 3, "")
	set lim to my argInt(argv, 4, 20)
	set unreadOnly to my argBool(argv, 5, false)
	set scanLimit to my argInt(argv, 6, 300)
	if lim < 1 then set lim to 1
	if scanLimit < 1 then set scanLimit to 1

	set hits to {}
	set scanned to 0
	set hitCount to 0
	set boxLabels to {}

	tell application "Mail"
		set boxes to {}
		repeat with a in accounts
			set aName to ""
			try
				set aName to (name of a) as text
			end try
			if acctName is "" or aName is acctName then
				try
					set end of boxes to {mailbox mboxName of a, aName}
				end try
			end if
		end repeat
		if (count of boxes) is 0 and acctName is "" then
			try
				set end of boxes to {mailbox mboxName, ""}
			end try
		end if

		repeat with entry in boxes
			if scanned >= scanLimit then exit repeat
			set b to item 1 of (contents of entry)
			set ownerName to item 2 of (contents of entry)
			set total to 0
			try
				set total to (count of messages of b)
			end try
			if total > 0 then
				set take to scanLimit - scanned
				if take > total then set take to total
				set idList to {}
				set subjList to {}
				set senderList to {}
				set dateList to {}
				set readList to {}
				try
					set idList to my asList(get id of (messages 1 thru take of b))
					set subjList to my asList(get subject of (messages 1 thru take of b))
					set senderList to my asList(get sender of (messages 1 thru take of b))
					set dateList to my asList(get date received of (messages 1 thru take of b))
					set readList to my asList(get read status of (messages 1 thru take of b))
				end try
				set n to (count of idList)
				set scanned to scanned + n
				repeat with i from 1 to n
					if hitCount >= lim then exit repeat
					set subj to my itemOr(subjList, i, "")
					set sndr to my itemOr(senderList, i, "")
					set isRead to my itemOr(readList, i, true)
					set keep to true
					if unreadOnly and isRead then set keep to false
					if keep and qy is not "" then
						if not (my containsCI(subj, qy)) then
							if not (my containsCI(sndr, qy)) then set keep to false
						end if
					end if
					if keep then
						set hitCount to hitCount + 1
						set subjClip to my clip(subj, 200)
						set end of hits to my jsonObject({my jsonField("id", my jsonString((my itemOr(idList, i, "")) as text)), my jsonField("mailbox", my jsonString(mboxName)), my jsonField("account", my jsonString(ownerName)), my jsonField("subject", my jsonString(item 1 of subjClip)), my jsonField("sender", my jsonString(item 1 of (my clip(sndr, 200)))), my jsonField("receivedAt", my jsonDate(my itemOr(dateList, i, missing value))), my jsonField("unread", my jsonBool(not isRead))})
					end if
				end repeat
			end if
			set end of boxLabels to ownerName
		end repeat
	end tell

	set wasTruncated to (scanned >= scanLimit)
	return my jsonObject({my jsonField("messages", my jsonArray(hits)), my jsonField("count", my jsonInt(hitCount)), my jsonField("scanned", my jsonInt(scanned)), my jsonField("scanTruncated", my jsonBool(wasTruncated))})
end run
