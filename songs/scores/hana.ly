% 花 (瀧廉太郎) - Wikipedia 日本語版（CC BY-SA 4.0）
% https://ja.wikipedia.org/w/index.php?title=%E8%8A%B1%20%28%E7%80%A7%E5%BB%89%E5%A4%AA%E9%83%8E%29&oldid=110688119
% The melody only, as the article has it; checked against the first songbook (API-SONGS S-2).
\relative {
    \set Staff.midiInstrument = #"piano"
	\key f \major
	\time 2/2
	\tempo 2 = 180
    \new Voice \relative c' {
	c4. c8 f4 r8 f8 g8 f8 e8 d8 c2 a8 c8 f8 g8 a4 c4 g2 r2 \bar "||" \break
    c,4. c8 f4 r8 f8 g8 f8 d8 e8 c2 g'4. g8 g4 a4 f2 r2 \bar "||" \break
    c'4. c8 c4. a8 bes4. bes8 bes4 r8 g8 a2 d,4 g4 c,2. r4 \bar "||" \break
    c4. c8 f4 f4 g8 f8 e8 d8 c2 g'4 g8. a16 bes4 g4 f2 r2 \bar "|."
    }
}
