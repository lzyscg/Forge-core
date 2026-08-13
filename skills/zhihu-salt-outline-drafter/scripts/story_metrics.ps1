param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [string]$ReferencePath,

    [switch]$CompareChapters,

    [Nullable[double]]$HanTolerance,

    [Nullable[double]]$ParagraphTolerance
)

$ErrorActionPreference = 'Stop'

if (($null -eq $HanTolerance) -ne ($null -eq $ParagraphTolerance)) {
    throw 'HanTolerance and ParagraphTolerance must be supplied together.'
}

if ($null -ne $HanTolerance -and -not $ReferencePath) {
    throw 'Tolerance parameters require ReferencePath.'
}

if (($null -ne $HanTolerance -and $HanTolerance -lt 0) -or
    ($null -ne $ParagraphTolerance -and $ParagraphTolerance -lt 0)) {
    throw 'Tolerance values must be zero or positive ratios, for example 0.15.'
}

if ($CompareChapters -and -not $ReferencePath) {
    throw 'CompareChapters requires ReferencePath.'
}

$explanationPattern = '\u610f\u8bc6\u5230|\u7ec8\u4e8e\u660e\u767d|\u8fd9\u8bf4\u660e|\u663e\u7136|\u539f\u6765\u5982\u6b64|\u4e5f\u5c31\u662f\u8bf4|\u8fd9\u4e5f\u80fd\u89e3\u91ca|\u51e0\u4e4e\u53ef\u4ee5\u786e\u5b9a|\u770b\u6765'
$knowledgeAssertionPattern = '\u53ea\u5728\u7b49|\u65e9\u5c31\u77e5\u9053|\u771f\u6b63\u60f3|\u771f\u6b63\u76ee\u7684'
$metaNarrationPattern = '\u63a8\u8fdb\u5267\u60c5|\u9605\u8bfb\u52a8\u529b|\u672c\u7ae0\u7684\u94a9\u5b50|\u8ba9\u7b2c[\u4e00-\u9fff\d]+\u7ae0|\u4e0a\u4e00\u7ae0|\u4e0b\u4e00\u7ae0'
$metaphorPattern = '\u4eff\u4f5b|\u5982\u540c|\u597d\u50cf|\u50cf\u4e00\u628a|\u50cf\u4e00\u6839|\u50cf\u4e00\u573a|\u50cf\u4e00\u4e2a'

function Get-ReviewFlags {
    param([string]$Text)

    [pscustomobject]@{
        explanatory_phrase_hits = ([regex]::Matches($Text, $explanationPattern)).Count
        possible_knowledge_assertion_hits = ([regex]::Matches($Text, $knowledgeAssertionPattern)).Count
        possible_writing_meta_hits = ([regex]::Matches($Text, $metaNarrationPattern)).Count
        metaphor_language_hits = ([regex]::Matches($Text, $metaphorPattern)).Count
    }
}

function Measure-Body {
    param(
        [string]$Text,
        [string[]]$Paragraphs
    )

    $paragraphHan = @($Paragraphs | ForEach-Object {
        ([regex]::Matches($_, '[\u4e00-\u9fff]')).Count
    })
    $sorted = @($paragraphHan | Sort-Object)
    if ($sorted.Count -eq 0) {
        $median = 0
    } elseif ($sorted.Count % 2 -eq 1) {
        $median = $sorted[[math]::Floor($sorted.Count / 2)]
    } else {
        $middle = $sorted.Count / 2
        $median = [math]::Round(($sorted[$middle - 1] + $sorted[$middle]) / 2, 1)
    }

    $dialogueParagraphs = @($Paragraphs | Where-Object {
        $_.TrimStart() -match '^[\u201c\u300c]'
    }).Count

    [pscustomobject]@{
        han = ([regex]::Matches($Text, '[\u4e00-\u9fff]')).Count
        paragraphs = $Paragraphs.Count
        average_han_per_paragraph = if ($Paragraphs.Count) {
            [math]::Round((($paragraphHan | Measure-Object -Sum).Sum / $Paragraphs.Count), 1)
        } else { 0 }
        median_han_per_paragraph = $median
        dialogue_paragraph_ratio = if ($Paragraphs.Count) {
            [math]::Round($dialogueParagraphs / $Paragraphs.Count, 3)
        } else { 0 }
    }
}

function Measure-StoryText {
    param([string]$InputPath)

    $raw = Get-Content -Raw -Encoding UTF8 -LiteralPath $InputPath
    $lines = Get-Content -Encoding UTF8 -LiteralPath $InputPath
    $paragraphs = @($lines | Where-Object {
        $_.Trim().Length -gt 0 -and -not $_.TrimStart().StartsWith('#')
    })

    $chapters = @()
    $markdownMatches = [regex]::Matches(
        $raw,
        '(?ms)^##\s+([^\r\n]+)\r?\n(.*?)(?=^##\s+|\z)'
    )

    if ($markdownMatches.Count -gt 0) {
        foreach ($match in $markdownMatches) {
            $body = $match.Groups[2].Value
            $bodyParagraphs = @(($body -split '\r?\n') | Where-Object { $_.Trim().Length -gt 0 })
            $chapters += [pscustomobject]@{
                title = $match.Groups[1].Value.Trim()
                descriptive_metrics = Measure-Body -Text $body -Paragraphs $bodyParagraphs
                review_flags = Get-ReviewFlags -Text $body
            }
        }
    } else {
        $numericMatches = [regex]::Matches(
            $raw,
            '(?ms)^\s*(\d{1,3})\s*\r?\n(.*?)(?=^\s*\d{1,3}\s*\r?\n|\z)'
        )
        $prefix = if ($numericMatches.Count -gt 0) {
            $raw.Substring(0, $numericMatches[0].Index).Trim()
        } else { '' }

        for ($i = 0; $i -lt $numericMatches.Count; $i++) {
            $body = $numericMatches[$i].Groups[2].Value
            if ($i -eq 0 -and $prefix.Length -gt 0) {
                $body = $prefix + "`n" + $body
            }
            $bodyParagraphs = @(($body -split '\r?\n') | Where-Object { $_.Trim().Length -gt 0 })
            $chapters += [pscustomobject]@{
                title = $numericMatches[$i].Groups[1].Value.Trim()
                descriptive_metrics = Measure-Body -Text $body -Paragraphs $bodyParagraphs
                review_flags = Get-ReviewFlags -Text $body
            }
        }
    }

    [pscustomobject]@{
        path = (Resolve-Path -LiteralPath $InputPath).Path
        descriptive_metrics = Measure-Body -Text $raw -Paragraphs $paragraphs
        review_flags = Get-ReviewFlags -Text $raw
        chapters = $chapters
    }
}

function Get-DeltaRatio {
    param(
        [double]$DraftValue,
        [double]$ReferenceValue
    )

    if ($ReferenceValue -le 0) { return $null }
    [math]::Round(($DraftValue - $ReferenceValue) / $ReferenceValue, 3)
}

$result = [ordered]@{
    draft = Measure-StoryText -InputPath $Path
    measurement_notes = @(
        'Review flags are lexical search hints, not errors or release criteria.',
        'Dialogue ratio counts paragraphs beginning with Chinese dialogue quotation marks.',
        'Quantitative similarity does not replace semantic, continuity, reality, or style review.'
    )
}

if ($ReferencePath) {
    $result.reference = Measure-StoryText -InputPath $ReferencePath

    if ($CompareChapters) {
        $draftChapters = @($result.draft.chapters)
        $referenceChapters = @($result.reference.chapters)
        $comparisonCount = [math]::Min($draftChapters.Count, $referenceChapters.Count)
        if ($comparisonCount -eq 0) {
            throw 'CompareChapters found no chapter headings in one or both files.'
        }
        $chapterCountMatch = $draftChapters.Count -eq $referenceChapters.Count
        $chapterDeltas = @()
        $allHanWithin = $true
        $allParagraphsWithin = $true

        for ($i = 0; $i -lt $comparisonCount; $i++) {
            $draftMetrics = $draftChapters[$i].descriptive_metrics
            $referenceMetrics = $referenceChapters[$i].descriptive_metrics
            $hanDelta = Get-DeltaRatio -DraftValue $draftMetrics.han -ReferenceValue $referenceMetrics.han
            $paragraphDelta = Get-DeltaRatio -DraftValue $draftMetrics.paragraphs -ReferenceValue $referenceMetrics.paragraphs

            $entry = [ordered]@{
                draft_title = $draftChapters[$i].title
                reference_title = $referenceChapters[$i].title
                han_delta_ratio = $hanDelta
                paragraph_delta_ratio = $paragraphDelta
                dialogue_ratio_delta = [math]::Round(
                    $draftMetrics.dialogue_paragraph_ratio - $referenceMetrics.dialogue_paragraph_ratio,
                    3
                )
                average_han_per_paragraph_delta_ratio = Get-DeltaRatio `
                    -DraftValue $draftMetrics.average_han_per_paragraph `
                    -ReferenceValue $referenceMetrics.average_han_per_paragraph
                median_han_per_paragraph_delta_ratio = Get-DeltaRatio `
                    -DraftValue $draftMetrics.median_han_per_paragraph `
                    -ReferenceValue $referenceMetrics.median_han_per_paragraph
            }

            if ($null -ne $HanTolerance) {
                $entry.han_within_requested_tolerance = $null -ne $hanDelta -and [math]::Abs($hanDelta) -le $HanTolerance
                $entry.paragraphs_within_requested_tolerance = $null -ne $paragraphDelta -and [math]::Abs($paragraphDelta) -le $ParagraphTolerance
                if (-not $entry.han_within_requested_tolerance) { $allHanWithin = $false }
                if (-not $entry.paragraphs_within_requested_tolerance) { $allParagraphsWithin = $false }
            }
            $chapterDeltas += [pscustomobject]$entry
        }

        $result.comparison_deltas = [pscustomobject]@{
            scope = 'chapters_by_position'
            comparable_chapters = $comparisonCount
            draft_chapters = $draftChapters.Count
            reference_chapters = $referenceChapters.Count
            chapter_counts_match = $chapterCountMatch
            chapters = $chapterDeltas
        }

        if ($null -ne $HanTolerance) {
            $result.target_ranges_met = [pscustomobject]@{
                scope = 'chapters_by_position'
                han_tolerance = $HanTolerance
                paragraph_tolerance = $ParagraphTolerance
                chapter_counts_match = $chapterCountMatch
                all_han_within_requested_tolerance = $allHanWithin
                all_paragraphs_within_requested_tolerance = $allParagraphsWithin
                quantitative_diagnostic_only = $true
            }
        }
    } else {
        $draftMetrics = $result.draft.descriptive_metrics
        $referenceMetrics = $result.reference.descriptive_metrics
        $hanDelta = Get-DeltaRatio -DraftValue $draftMetrics.han -ReferenceValue $referenceMetrics.han
        $paragraphDelta = Get-DeltaRatio -DraftValue $draftMetrics.paragraphs -ReferenceValue $referenceMetrics.paragraphs

        $result.comparison_deltas = [pscustomobject]@{
            scope = 'whole_text'
            han_delta_ratio = $hanDelta
            paragraph_delta_ratio = $paragraphDelta
            dialogue_ratio_delta = [math]::Round(
                $draftMetrics.dialogue_paragraph_ratio - $referenceMetrics.dialogue_paragraph_ratio,
                3
            )
            average_han_per_paragraph_delta_ratio = Get-DeltaRatio `
                -DraftValue $draftMetrics.average_han_per_paragraph `
                -ReferenceValue $referenceMetrics.average_han_per_paragraph
            median_han_per_paragraph_delta_ratio = Get-DeltaRatio `
                -DraftValue $draftMetrics.median_han_per_paragraph `
                -ReferenceValue $referenceMetrics.median_han_per_paragraph
            scaled_reference_paragraphs_for_draft_han = if ($referenceMetrics.han -gt 0) {
                [math]::Round($referenceMetrics.paragraphs * $draftMetrics.han / $referenceMetrics.han, 1)
            } else { $null }
        }

        if ($null -ne $HanTolerance) {
            $result.target_ranges_met = [pscustomobject]@{
                scope = 'whole_text'
                han_tolerance = $HanTolerance
                paragraph_tolerance = $ParagraphTolerance
                han_within_requested_tolerance = $null -ne $hanDelta -and [math]::Abs($hanDelta) -le $HanTolerance
                paragraphs_within_requested_tolerance = $null -ne $paragraphDelta -and [math]::Abs($paragraphDelta) -le $ParagraphTolerance
                quantitative_diagnostic_only = $true
            }
        }
    }
}

$result | ConvertTo-Json -Depth 8
