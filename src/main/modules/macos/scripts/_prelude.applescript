-- Shared handlers, prepended to every script at materialisation time.
--
-- AppleScript has no include mechanism, so `scripts.ts` concatenates this file
-- in front of each script body before writing the compiled-on-first-use file to
-- disk. Keeping it in its own file means it is diffable, lintable and testable
-- exactly once instead of copy-pasted twenty times.
--
-- Three rules this file exists to enforce:
--
--  1. **Output is JSON, and the JSON is pure ASCII.** `osascript`'s stdout
--     encoding is not dependable across locales and macOS releases, so every
--     character above 0x7E is emitted as a `\uXXXX` escape (surrogate pairs for
--     astral code points). The bytes we hand to Node are therefore
--     encoding-independent and `JSON.parse` restores the original text exactly.
--  2. **No locale-dependent number formatting.** Only integers are ever
--     rendered with `as text`; a fractional number formats with a comma in some
--     locales and would produce invalid JSON. Dates go out as ISO strings.
--  3. **No non-ASCII in the source.** `<=` rather than the pretty operator, no
--     continuation character. Every script file is asserted ASCII-only by test,
--     which removes a whole class of "compiles on my Mac" surprises.
--
-- Errors are deliberately NOT caught here. An AppleScript error propagates,
-- `osascript` exits non-zero and prints `... (-1743)` on stderr, and the runner
-- turns that number into a typed domain error. Swallowing it would throw away
-- the only signal permission denial gives us.

on jsonHex4(n)
	set digits to "0123456789abcdef"
	set out to ""
	set d to ((n div 4096) mod 16)
	set out to out & (character (d + 1) of digits)
	set d to ((n div 256) mod 16)
	set out to out & (character (d + 1) of digits)
	set d to ((n div 16) mod 16)
	set out to out & (character (d + 1) of digits)
	set d to (n mod 16)
	set out to out & (character (d + 1) of digits)
	return out
end jsonHex4

-- Encode a value as a JSON string literal, including the surrounding quotes.
-- `missing value` becomes the JSON null literal so callers do not have to
-- special-case every optional property.
on jsonString(theValue)
	if theValue is missing value then return "null"
	set src to theValue as text
	set acc to {}
	repeat with ch in (characters of src)
		set c to (contents of ch)
		set n to (id of c)
		if n = 34 then
			set end of acc to "\\\""
		else if n = 92 then
			set end of acc to "\\\\"
		else if n = 8 then
			set end of acc to "\\b"
		else if n = 9 then
			set end of acc to "\\t"
		else if n = 10 then
			set end of acc to "\\n"
		else if n = 12 then
			set end of acc to "\\f"
		else if n = 13 then
			set end of acc to "\\r"
		else if n < 32 then
			set end of acc to "\\u" & my jsonHex4(n)
		else if n < 127 then
			set end of acc to c
		else if n > 65535 then
			set m to n - 65536
			set hi to 55296 + (m div 1024)
			set lo to 56320 + (m mod 1024)
			set end of acc to "\\u" & my jsonHex4(hi) & "\\u" & my jsonHex4(lo)
		else
			set end of acc to "\\u" & my jsonHex4(n)
		end if
	end repeat
	return "\"" & my joinText(acc, "") & "\""
end jsonString

-- Integers only. See rule 2 at the top of this file.
on jsonInt(n)
	if n is missing value then return "null"
	return ((n as integer) as text)
end jsonInt

on jsonBool(b)
	if b is missing value then return "null"
	if b then return "true"
	return "false"
end jsonBool

-- NOTE: the parameter must NOT be named `items` — that is a reserved AppleScript
-- term (a built-in list/text property), and using it as a formal parameter fails
-- to compile with "items is illegal as a formal parameter", which broke every
-- script that includes this prelude (e.g. reminders-create).
on joinText(itemList, sep)
	set savedTid to AppleScript's text item delimiters
	set AppleScript's text item delimiters to sep
	set res to (itemList as text)
	set AppleScript's text item delimiters to savedTid
	return res
end joinText

on splitText(t, sep)
	if t is missing value then return {}
	set s to t as text
	if s is "" then return {}
	set savedTid to AppleScript's text item delimiters
	set AppleScript's text item delimiters to sep
	set parts to (text items of s)
	set AppleScript's text item delimiters to savedTid
	set acc to {}
	repeat with p in parts
		set v to (contents of p)
		if v is not "" then set end of acc to v
	end repeat
	return acc
end splitText

on jsonArray(encodedItems)
	return "[" & my joinText(encodedItems, ",") & "]"
end jsonArray

on jsonObject(encodedPairs)
	return "{" & my joinText(encodedPairs, ",") & "}"
end jsonObject

on jsonField(k, encodedValue)
	return my jsonString(k) & ":" & encodedValue
end jsonField

-- A list of plain strings as a JSON array of strings.
on jsonStringArray(values)
	set acc to {}
	repeat with v in values
		set end of acc to my jsonString(contents of v)
	end repeat
	return my jsonArray(acc)
end jsonStringArray

on pad2(n)
	if n < 10 then return "0" & (n as text)
	return (n as text)
end pad2

-- ISO-8601 with the machine's current UTC offset, e.g. 2026-08-07T10:31:00+02:00.
--
-- The offset comes from `time to GMT`, which is the offset in force *now* rather
-- than the one in force at `d`. Across a DST boundary a timestamp can therefore
-- be an hour out. Converting properly needs a timezone database AppleScript does
-- not have; the alternative (emitting a naive local time with no offset) is
-- worse because it is silently wrong in every timezone rather than loudly wrong
-- twice a year.
on jsonDate(d)
	if d is missing value then return "null"
	set y to year of d
	set mo to (month of d) as integer
	set dy to day of d
	set hh to hours of d
	set mi to minutes of d
	set ss to seconds of d
	set offSecs to (time to GMT)
	if offSecs < 0 then
		set sign to "-"
		set absOff to -offSecs
	else
		set sign to "+"
		set absOff to offSecs
	end if
	set offH to absOff div 3600
	set offM to (absOff mod 3600) div 60
	set stamp to (y as text) & "-" & my pad2(mo) & "-" & my pad2(dy) & "T"
	set stamp to stamp & my pad2(hh) & ":" & my pad2(mi) & ":" & my pad2(ss)
	set stamp to stamp & sign & my pad2(offH) & ":" & my pad2(offM)
	return my jsonString(stamp)
end jsonDate

-- Build a date from integer components.
--
-- Day is reset to 1 before the year and month are set: setting `day` first and
-- `month` second turns 31 January into an error (or 2 March) the moment the
-- target month is shorter. This ordering is the standard fix and the reason
-- dates cross the boundary as components rather than as a parsed string --
-- AppleScript's `date "..."` coercion is locale-dependent and unfixable.
on dateFromParts(y, mo, dy, hh, mi, ss)
	set d to (current date)
	set day of d to 1
	set year of d to y
	set month of d to mo
	set day of d to dy
	set time of d to (hh * 3600) + (mi * 60) + ss
	return d
end dateFromParts

on argAt(argv, i, fallbackValue)
	if (count of argv) < i then return fallbackValue
	set v to (item i of argv) as text
	if v is "" then return fallbackValue
	return v
end argAt

on argInt(argv, i, fallbackValue)
	set v to my argAt(argv, i, "")
	if v is "" then return fallbackValue
	try
		return (v as integer)
	on error
		return fallbackValue
	end try
end argInt

on argBool(argv, i, fallbackValue)
	set v to my argAt(argv, i, "")
	if v is "" then return fallbackValue
	if v is "1" then return true
	if v is "true" then return true
	return false
end argBool

-- A date assembled from six consecutive argv slots starting at `i`, or
-- `missing value` when the first slot is empty.
on argDate(argv, i, fallbackValue)
	set y to my argInt(argv, i, 0)
	if y = 0 then return fallbackValue
	set mo to my argInt(argv, i + 1, 1)
	set dy to my argInt(argv, i + 2, 1)
	set hh to my argInt(argv, i + 3, 0)
	set mi to my argInt(argv, i + 4, 0)
	set ss to my argInt(argv, i + 5, 0)
	return my dateFromParts(y, mo, dy, hh, mi, ss)
end argDate

-- Returns {text, wasTruncated}. Bounding text before it reaches jsonString is
-- what keeps the per-character escape loop affordable.
on clip(t, n)
	if t is missing value then return {"", false}
	set s to t as text
	if (count of characters of s) <= n then return {s, false}
	return {(text 1 thru n of s), true}
end clip

on lowerCase(t)
	if t is missing value then return ""
	set s to t as text
	set acc to {}
	repeat with ch in (characters of s)
		set c to (contents of ch)
		set n to (id of c)
		if n >= 65 and n <= 90 then
			set end of acc to (character id (n + 32))
		else
			set end of acc to c
		end if
	end repeat
	return my joinText(acc, "")
end lowerCase

-- Case-insensitive substring test. `ignoring case` would be shorter but its
-- behaviour depends on the running application's own considering/ignoring
-- state, which Mail in particular does not leave alone.
on containsCI(haystack, needle)
	if needle is "" then return true
	if haystack is missing value then return false
	return (my lowerCase(haystack)) contains (my lowerCase(needle))
end containsCI

-- Coerce a possibly-single Apple Event result into a list. A range specifier
-- that matches exactly one element does not always come back wrapped.
on asList(v)
	if v is missing value then return {}
	if (class of v) is list then return v
	return {v}
end asList

on itemOr(theList, i, fallbackValue)
	if (count of theList) < i then return fallbackValue
	set v to (contents of (item i of theList))
	if v is missing value then return fallbackValue
	return v
end itemOr
