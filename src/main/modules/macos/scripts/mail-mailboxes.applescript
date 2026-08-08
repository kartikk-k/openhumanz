-- Accounts and their top-level mailbox names, in one pass.
--
-- argv: none
--
-- `get name of (mailboxes of a)` is one Apple Event returning a list, rather
-- than one event per mailbox. That distinction is the whole performance story
-- for Mail scripting and it recurs in every script here.

on run argv
	set accOut to {}
	tell application "Mail"
		repeat with a in accounts
			set aName to ""
			try
				set aName to (name of a) as text
			end try
			set aEnabled to true
			try
				set aEnabled to (enabled of a)
			end try
			set boxNames to {}
			try
				set boxNames to my asList(get name of (mailboxes of a))
			end try
			set end of accOut to my jsonObject({my jsonField("account", my jsonString(aName)), my jsonField("enabled", my jsonBool(aEnabled)), my jsonField("mailboxes", my jsonStringArray(boxNames))})
		end repeat
	end tell
	return my jsonObject({my jsonField("accounts", my jsonArray(accOut))})
end run
