-- Create a draft and open it in Mail. It is never sent.
--
-- argv:
--   1  to addresses    newline separated
--   2  cc addresses    newline separated
--   3  bcc addresses   newline separated
--   4  subject
--   5  body
--   6  sender address  "" to let Mail pick the account
--
-- There is no `send` anywhere in this module, and there is no tool that could
-- reach one. The gap between "drafted" and "sent" is the gap between a bug and
-- an incident: a drafted message sitting in front of the user is recoverable by
-- closing a window, a sent one is not recoverable at all. `visible:true` plus
-- `activate` is the mechanism -- the user sees exactly what was written, in the
-- application they already trust, before anything leaves the machine.
--
-- `save` is deliberately not called either. Saving would file it in Drafts,
-- where a later mistake could pick it up; leaving it open and unsaved means
-- abandoning it is the default outcome.

on run argv
	set toList to my splitText(my argAt(argv, 1, ""), linefeed)
	set ccList to my splitText(my argAt(argv, 2, ""), linefeed)
	set bccList to my splitText(my argAt(argv, 3, ""), linefeed)
	set subj to my argAt(argv, 4, "")
	set bodyText to my argAt(argv, 5, "")
	set senderAddr to my argAt(argv, 6, "")

	set draftId to ""
	tell application "Mail"
		set newMsg to make new outgoing message with properties {subject:subj, content:bodyText, visible:true}
		if senderAddr is not "" then
			try
				set sender of newMsg to senderAddr
			end try
		end if
		tell newMsg
			repeat with r in toList
				make new to recipient at end of to recipients with properties {address:(contents of r)}
			end repeat
			repeat with r in ccList
				make new cc recipient at end of cc recipients with properties {address:(contents of r)}
			end repeat
			repeat with r in bccList
				make new bcc recipient at end of bcc recipients with properties {address:(contents of r)}
			end repeat
		end tell
		try
			set draftId to (id of newMsg) as text
		end try
		activate
	end tell

	return my jsonObject({my jsonField("ok", my jsonBool(true)), my jsonField("sent", my jsonBool(false)), my jsonField("opened", my jsonBool(true)), my jsonField("draftId", my jsonString(draftId)), my jsonField("recipientCount", my jsonInt((count of toList) + (count of ccList) + (count of bccList)))})
end run
