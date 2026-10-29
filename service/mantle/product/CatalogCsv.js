// Bounded UTF-8 delimited catalog files. Quotes may contain separators, escaped quotes and newlines.
function parse(text, delimiter = ",") {
    text = String(text || "").replace(/^\ufeff/, "")
    if (text.includes("\0")) throw new Error("CSV text cannot contain NUL bytes; save it as UTF-8")
    if (![",", ";", "\t"].includes(delimiter)) throw new Error("Choose comma, semicolon or tab")
    if (!text || text.length > 2 * 1024 * 1024) throw new Error("Choose a UTF-8 file containing at most 2 MiB")
    let byteLength = 0
    for (const c of text) {
        const point = c.codePointAt(0)
        byteLength += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4
        if (byteLength > 2 * 1024 * 1024) throw new Error("Choose a UTF-8 file containing at most 2 MiB")
    }
    const records = []
    let row = [],
        value = "",
        quoted = false,
        closed = false
    const cell = () => {
            row.push(value)
            value = ""
            closed = false
        },
        line = () => {
            cell()
            if (row.some(v => v !== "")) records.push(row)
            row = []
            if (records.length > 5001) throw new Error("Import at most 5000 data rows")
        }
    for (let i = 0; i < text.length; i++) {
        const c = text[i]
        if (quoted) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    value += '"'
                    i++
                } else {
                    quoted = false
                    closed = true
                }
            } else value += c
            continue
        }
        if (c === '"') {
            if (value || closed) throw new Error("A quote must begin a cell")
            quoted = true
        } else if (c === delimiter) cell()
        else if (c === "\r" || c === "\n") {
            if (c === "\r" && text[i + 1] === "\n") i++
            line()
        } else {
            if (closed && c !== " " && c !== "\t") throw new Error("Unexpected text after a quoted cell")
            if (!closed) value += c
        }
    }
    if (quoted) throw new Error("A quoted cell is not closed")
    if (value || row.length || closed) line()
    if (records.length < 2) throw new Error("Include a header and at least one data row")
    const headers = records.shift().map(s => s.trim())
    if (headers.some(s => !s || s.length > 100) || new Set(headers).size !== headers.length)
        throw new Error("Give each column a distinct header of 1–100 characters")
    if (headers.length > 100) throw new Error("Use at most 100 columns")
    return {
        headers,
        rows: records.map((cells, i) => ({
            rowNumber: i + 2,
            sourceValues: Object.fromEntries(headers.map((h, j) => [h, cells[j] ?? ""])),
            sourceError: cells.length > headers.length ? "This row has more cells than the header" : null
        }))
    }
}
function validateUtf8(bytes) {
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i]
        if (b < 128) continue
        let count,
            low = 128,
            high = 191
        if (b >= 194 && b <= 223) count = 1
        else if (b >= 224 && b <= 239) {
            count = 2
            if (b === 224) low = 160
            if (b === 237) high = 159
        } else if (b >= 240 && b <= 244) {
            count = 3
            if (b === 240) low = 144
            if (b === 244) high = 143
        } else throw new Error("The file is not valid UTF-8 at byte " + i)
        if (i + count >= bytes.length || bytes[i + 1] < low || bytes[i + 1] > high)
            throw new Error("The file is not valid UTF-8 at byte " + i)
        for (let n = 2; n <= count; n++)
            if (bytes[i + n] < 128 || bytes[i + n] > 191) throw new Error("The file is not valid UTF-8 at byte " + i)
        i += count
    }
    return true
}
const quote = v => {
    let s = String(v ?? "")
    if (/^[=+@-]/.test(s)) s = "'" + s
    return '"' + s.replace(/"/g, '""') + '"'
}
function csv(headers, rows) {
    return (
        "\ufeff" +
        headers.map(quote).join(",") +
        "\r\n" +
        rows.map(row => headers.map(h => quote(row[h])).join(",")).join("\r\n") +
        "\r\n"
    )
}
;({parse, csv, validateUtf8})
