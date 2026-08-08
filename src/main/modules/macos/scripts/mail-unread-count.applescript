-- Unread counts, whole inbox and per account.
--
-- argv:
--   1  mailbox name   default "INBOX"
--
-- Cheap enough to be the deterministic condition a scheduled job gates on --
-- see "Background work" in ARCHITECTURE.md. Nothing here iterates messages.

on run argv
	set mboxName to my argAt(argv, 1, "INBOX")
	set totalUnread to 0
	set perAccount to {}

	tell application "Mail"
		try
			set totalUnread to (unread count of inbox)
		end try
		repeat with a in accounts
			set aName to ""
			try
				set aName to (name of a) as text
			end try
			set n to 0
			try
				set n to (unread count of (mailbox mboxName of a))
			end try
			set end of perAccount to my jsonObject({my jsonField("account", my jsonString(aName)), my jsonField("unread", my jsonInt(n))})
		end repeat
	end tell

	return my jsonObject({my jsonField("mailbox", my jsonString(mboxName)), my jsonField("unread", my jsonInt(totalUnread)), my jsonField("accounts", my jsonArray(perAccount))})
end run
