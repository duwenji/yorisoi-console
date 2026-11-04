package console.validator

import io.github.duwenji.yorisoi.core.format.Activity
import io.github.duwenji.yorisoi.core.format.CueEvent
import io.github.duwenji.yorisoi.core.format.Feature
import io.github.duwenji.yorisoi.core.format.Genre
import io.github.duwenji.yorisoi.core.format.GuideLength
import io.github.duwenji.yorisoi.core.format.NarrationMode
import io.github.duwenji.yorisoi.core.format.PresentAs
import io.github.duwenji.yorisoi.core.format.Repeat
import io.github.duwenji.yorisoi.core.format.Slot
import io.github.duwenji.yorisoi.core.format.SoundChoice
import io.github.duwenji.yorisoi.core.format.SpotKind
import io.github.duwenji.yorisoi.core.format.TalkEventKind
import io.github.duwenji.yorisoi.core.format.TalkLevel
import io.github.duwenji.yorisoi.core.format.material.MaterialType
import io.github.duwenji.yorisoi.core.format.material.ResourceReader
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/** DES-014 R-10, RV-07: the values the console's screens offer are core-format's. */
class VocabularyTest {
    private val vocabulary = JSONObject(File("../packages/protocol/src/vocabulary.json").readText())

    private fun list(key: String): List<String> = vocabulary.getJSONArray(key).let { a -> (0 until a.length()).map(a::getString) }
    private fun map(key: String): Map<String, Any> = vocabulary.getJSONObject(key).let { o -> o.keys().asSequence().associateWith { o.get(it) } }
    private fun JSONArray.strings() = (0 until length()).map(::getString)

    @Test
    fun `the lists are core-format's, in its order`() {
        assertEquals(Activity.entries.map { it.json }, list("activities"))
        assertEquals(Genre.entries.map { it.json }, list("genres"))
        assertEquals(Feature.entries.map { it.json }, list("features"))
        assertEquals(TalkLevel.entries.map { it.json }, list("talkLevels"))
        assertEquals(TalkEventKind.entries.map { it.json }, list("talkEvents"))
        assertEquals(GuideLength.entries.map { it.json }, list("guideLengths"))
        assertEquals(SoundChoice.entries.map { it.json }, list("sounds"))
        assertEquals(CueEvent.entries.map { it.json }, list("cueEvents"))
        assertEquals(NarrationMode.entries.map { it.json }, list("narration"))
        assertEquals(Repeat.entries.map { it.json }, list("repeat"))
        assertEquals(MaterialType.entries.map { it.json }, list("materialTypes"))
    }

    @Test
    fun `spot kinds, slots, presentations and limits are core-format's`() {
        assertEquals(SpotKind.entries.associate { it.json to it.category }, map("spotKinds"))
        assertEquals(Slot.entries.associate { it.path to it.maxChars }, map("slots"))
        assertEquals(Slot.MAX_TOTAL_CHARS, vocabulary.getInt("slotsTotal"))
        assertEquals(
            PresentAs.entries.associate { p -> p.json to MaterialType.entries.filter { it in p.types }.map { it.json } },
            map("presentAs").mapValues { (it.value as JSONArray).strings() },
        )
        assertEquals(ResourceReader.MAX_TEXT_CHARS, vocabulary.getInt("textChars"))
    }
}
