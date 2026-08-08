-- One message, with a bounded body.
--
-- argv:
--   1  message id
--   2  mailbox name   default "INBOX"
--   3  account name   "" for every account
--   4  maxChars       body cap, default 2000
--
-- The id is matched with a `whose` clause on `id` only. That is an indexed
-- integer comparison inside Mail rather than a content scan, so it is the one
-- `whose` this module is willing to pay for.

on run argv
	set wantId to my argAt(argv, 1, "")
	set mboxName to my argAt(argv, 2, "INBOX")
	set acctName to my argAt(argv, 3, "")
	set maxChars to my argInt(argv, 4, 2000)
	if maxChars < 1 then set maxChars to 1
	if wantId is "" then return my jsonObject({my jsonField("found", my jsonBool(false))})
	set wantIdNum to my argInt(argv, 1, -1)

	set found to false
	set subj to ""
	set sndr to ""
	set replyAddr to ""
	set recips to {}
	set bodyText to ""
	set receivedAt to missing value
	set isRead to true
	set ownerName to ""

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
			if found then exit repeat
			set b to item 1 of (contents of entry)
			set candidate to missing value
			try
				set candidate to (first message of b whose id is wantIdNum)
			end try
			if candidate is not missing value then
				set found to true
				set ownerName to item 2 of (contents of entry)
				try
					set subj to (subject of candidate) as text
				end try
				try
					set sndr to (sender of candidate) as text
				end try
				try
					set replyAddr to (reply to of candidate) as text
				end try
				try
					set recips to my asList(get address of (to recipients of candidate))
				end try
				try
					set receivedAt to (date received of candidate)
				end try
				try
					set isRead to (read status of candidate)
				end try
				try
					set bodyText to (content of candidate) as text
				end try
			end if
		end repeat
	end tell

	if found is false then return my jsonObject({my jsonField("found", my jsonBool(false))})

	set bodyClip to my clip(bodyText, maxChars)
	return my jsonObject({my jsonField("found", my jsonBool(true)), my jsonField("id", my jsonString(wantId)), my jsonField("mailbox", my jsonString(mboxName)), my jsonField("account", my jsonString(ownerName)), my jsonField("subject", my jsonString(item 1 of (my clip(subj, 300)))), my jsonField("sender", my jsonString(item 1 of (my clip(sndr, 300)))), my jsonField("replyTo", my jsonString(item 1 of (my clip(replyAddr, 300)))), my jsonField("recipients", my jsonStringArray(recips)), my jsonField("receivedAt", my jsonDate(receivedAt)), my jsonField("unread", my jsonBool(not isRead)), my jsonField("body", my jsonString(item 1 of bodyClip)), my jsonField("bodyTruncated", my jsonBool(item 2 of bodyClip))})
end run
