-- Automation-permission probe for one app.
--
-- {{APP_NAME}} is an app-name placeholder: it renders to a quoted literal drawn
-- from a fixed allowlist (`escape.ts`), never from anything the agent supplies.
-- It has to be interpolated because `tell application <expr>` does not bind the
-- target app the way a literal does, and correct permission attribution depends
-- on the literal.
--
-- argv:
--   1  allowLaunch  "1" to send the event even when the app is not running
--
-- There is no way to read the Automation permission state without sending an
-- Apple Event, and sending one to a quit app launches it. So when the app is
-- not running and allowLaunch is off we report `probed: false` and the caller
-- leaves the permission `undetermined` rather than launching Mail behind the
-- user's back. Onboarding is the one place that passes allowLaunch.
--
-- Denial surfaces as an uncaught error -1743, which is exactly what the runner
-- needs; it is not swallowed here.

on run argv
	set allowLaunch to my argBool(argv, 1, false)
	set isRunning to false
	try
		set isRunning to (application {{APP_NAME}} is running)
	end try

	if (isRunning is false) and (allowLaunch is false) then
		return my jsonObject({my jsonField("running", my jsonBool(false)), my jsonField("probed", my jsonBool(false)), my jsonField("name", "null"), my jsonField("version", "null")})
	end if

	set appName to ""
	set appVersion to ""
	tell application {{APP_NAME}}
		set appName to (name as text)
		try
			set appVersion to (version as text)
		on error
			set appVersion to ""
		end try
	end tell

	return my jsonObject({my jsonField("running", my jsonBool(isRunning)), my jsonField("probed", my jsonBool(true)), my jsonField("name", my jsonString(appName)), my jsonField("version", my jsonString(appVersion))})
end run
