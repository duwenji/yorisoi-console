package console.validator

import io.github.duwenji.yorisoi.core.format.AccountIds
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.security.KeyPairGenerator
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** DES-014 R-16〜R-20: a draft reviewed as a submission would be, but for the signature. */
class DraftTest {
    private val publicKey = KeyPairGenerator.getInstance("Ed25519").generateKeyPair().public.encoded.takeLast(32).toByteArray()
    private val account = AccountIds.of(publicKey)
    private val other = AccountIds.of(KeyPairGenerator.getInstance("Ed25519").generateKeyPair().public.encoded.takeLast(32).toByteArray())

    private fun manifest(publisher: String = account, version: Int = 3) = JSONObject(
        """
        {
          "format": 1, "id": "kamakura-history", "version": $version, "publisher": "$publisher",
          "name": "鎌倉歴史散歩", "summary": "鎌倉の寺社と武士の歴史を、語り部の口調で", "lang": "ja",
          "activities": ["walk"],
          "greeting": "ここからは、鎌倉の歴史をたどりながら歩きましょう。",
          "talk": { "level": "normal",
                    "events": { "spot": true, "revisit": true, "milestone": true, "rest": false, "start": true, "finish": true } },
          "spots": { "prefer": ["temple"], "skip": [] },
          "guide": { "length": "long" },
          "mood": { "tone": true, "sound": "temple" }
        }
        """.trimIndent(),
    )

    private fun zip(files: Map<String, ByteArray>): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { z -> files.forEach { (name, bytes) -> z.putNextEntry(ZipEntry(name)); z.write(bytes); z.closeEntry() } }
        return out.toByteArray()
    }

    private fun draft(manifest: JSONObject = manifest(), icon: Boolean = true, extra: Map<String, ByteArray> = emptyMap()) = zip(
        buildMap {
            put("package/channel.json", manifest.toString().toByteArray())
            put("package/prompts/guide/focus.md", "- 由来と、関わった人物を中心に話す\n".toByteArray())
            put("draft.json", "{}".toByteArray())
            if (icon) put("icon.png", Draft.PLACEHOLDER_ICON)
            putAll(extra)
        },
    )

    private val upload = Upload("kamakura-history", "draft", account, latestApprovedVersion = 2)

    private fun review(draft: ByteArray, owner: String = account): Outcome {
        val contents = Draft.unpack(draft)
        val pkg = Draft.forReview(contents.files, Draft.Kind.CHANNEL, owner, publicKey)
        return MachineReview.review(upload, pkg, contents.icon ?: Draft.PLACEHOLDER_ICON, verifier = Draft.ACCEPT_ANY)
    }

    @Test
    fun `unpacks the package, the icon, and drops a signature`() {
        val contents = Draft.unpack(draft(extra = mapOf("package/signature.json" to "{}".toByteArray())))
        assertEquals(setOf("channel.json", "prompts/guide/focus.md"), contents.files.keys)
        assertTrue(contents.icon!!.contentEquals(Draft.PLACEHOLDER_ICON))
        assertNull(Draft.unpack(draft(icon = false)).icon)
    }

    @Test
    fun `a good draft passes without a signature`() {
        val outcome = review(draft())
        assertTrue("$outcome", outcome is Outcome.Passed)
    }

    @Test
    fun `the placeholder icon is a PNG the icon check takes`() {
        assertEquals(emptyList<Finding>(), MachineReview.iconFindings(Draft.PLACEHOLDER_ICON))
    }

    @Test
    fun `it still finds what a submission's review finds`() {
        // Another account in channel.json: as if signed with the account's key.
        assertEquals(listOf("publisher_mismatch"), (review(draft(manifest(publisher = other))) as Outcome.Failed).findings.map { it.code })
        // Not after the approved version.
        assertEquals(listOf("version_not_newer"), (review(draft(manifest(version = 2))) as Outcome.Failed).findings.map { it.code })
        // A file the format doesn't allow.
        val unexpected = review(draft(extra = mapOf("package/notes.txt" to "x".toByteArray())))
        assertEquals(listOf("unexpected_file"), (unexpected as Outcome.Failed).findings.map { it.code })
        // channel.json that isn't JSON.
        assertFalse(review(zip(mapOf("package/channel.json" to "{".toByteArray()))) is Outcome.Passed)
    }

    @Test
    fun `a submission's review still verifies the signature`() {
        val contents = Draft.unpack(draft())
        val pkg = Draft.forReview(contents.files, Draft.Kind.CHANNEL, account, publicKey)
        assertEquals(listOf("bad_signature"), (MachineReview.review(upload, pkg, Draft.PLACEHOLDER_ICON) as Outcome.Failed).findings.map { it.code })
    }
}
