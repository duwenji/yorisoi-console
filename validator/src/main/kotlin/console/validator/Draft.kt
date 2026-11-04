package console.validator

import io.github.duwenji.yorisoi.core.format.Ed25519Verifier
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.Base64
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

/**
 * A draft as the console keeps it (DES-014 R-3), and the package the machine review reads from it
 * (R-17). Pure: the Lambda reads and writes, this builds.
 */
object Draft {
    const val PACKAGE_DIR = "package/"
    const val ICON = "icon.png"

    /** What a draft holds: the package's files (paths as in the package) and the icon if there is one. */
    data class Contents(val files: Map<String, ByteArray>, val icon: ByteArray?)

    enum class Kind(val manifest: String, val type: String, val subjectKey: String, val ownerKey: String) {
        CHANNEL("channel.json", "channel-package", "channel", "publisher"),
        COLLECTION("collection.json", "collection-package", "collection", "producer"),
    }

    /** Unpacks a draft. A `signature.json` in it is dropped (R-2); a draft that isn't a ZIP has no files. */
    fun unpack(draft: ByteArray): Contents {
        val files = linkedMapOf<String, ByteArray>()
        var icon: ByteArray? = null
        ZipInputStream(ByteArrayInputStream(draft)).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                if (entry.isDirectory) continue
                val bytes = zip.readBytes()
                when {
                    entry.name == ICON -> icon = bytes
                    entry.name.startsWith(PACKAGE_DIR) -> {
                        val path = entry.name.removePrefix(PACKAGE_DIR)
                        if (path.isNotEmpty() && path != "signature.json") files[path] = bytes
                    }
                }
            }
        }
        return Contents(files, icon)
    }

    /**
     * The package with a `signature.json` naming the account's key over every file's SHA-256 and
     * no real signature (R-17): read with [ACCEPT_ANY], core-format then checks everything a
     * submission's review checks but the signature itself, `publisher_mismatch` included.
     * The subject and version are the manifest's, as a real signature would have them.
     */
    fun forReview(files: Map<String, ByteArray>, kind: Kind, owner: String, publicKey: ByteArray): ByteArray {
        val manifest = files[kind.manifest]?.let { runCatching { JSONObject(String(it, Charsets.UTF_8)) }.getOrNull() }
        val hashes = JSONObject()
        for ((path, bytes) in files) hashes.put(path, MachineReview.sha256Hex(bytes))
        val payload = JSONObject()
            .put("type", kind.type)
            .put(kind.subjectKey, manifest?.optString("id", "") ?: "")
            .put("version", manifest?.opt("version").takeIf { it is Int } ?: 0)
            .put(kind.ownerKey, owner)
            .put("files", hashes)
        val b64 = Base64.getUrlEncoder().withoutPadding()
        val signature = JSONObject()
            .put("payload", b64.encodeToString(payload.toString().toByteArray(Charsets.UTF_8)))
            .put("publisherKey", b64.encodeToString(publicKey))
            .put("sig", b64.encodeToString(ByteArray(64)))
        return zip(files + ("signature.json" to signature.toString().toByteArray(Charsets.UTF_8)))
    }

    /** Takes any signature: a draft has none (R-17). Never used for a submission. */
    val ACCEPT_ANY = Ed25519Verifier { _, _, _ -> true }

    /** A 1×1 PNG, for a draft without an icon: the icon check is skipped and `icon_missing` warned instead (R-20). */
    val PLACEHOLDER_ICON: ByteArray = Base64.getDecoder().decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    )

    private fun zip(files: Map<String, ByteArray>): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            for ((path, bytes) in files) {
                zip.putNextEntry(ZipEntry(path))
                zip.write(bytes)
                zip.closeEntry()
            }
        }
        return out.toByteArray()
    }
}
