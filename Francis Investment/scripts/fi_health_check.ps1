<#
.SYNOPSIS
  Francis Investment health check.
.DESCRIPTION
  Checks the five supervisory APIs and prints the migration-critical fields.
.PARAMETER BaseUrl
  Service URL. Defaults to http://localhost:8765.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\fi_health_check.ps1
  powershell -ExecutionPolicy Bypass -File scripts\fi_health_check.ps1 -BaseUrl "http://8.153.101.112:8765"
#>

param(
  [string]$BaseUrl = "http://localhost:8765"
)

$ErrorActionPreference = "Continue"
$script:ExitCode = 0

function Write-Section {
  param([string]$Title)
  Write-Host ""
  Write-Host "== $Title ==" -ForegroundColor Cyan
}

function Write-Ok {
  param([string]$Message)
  Write-Host "  [OK] $Message" -ForegroundColor Green
}

function Write-Warn {
  param([string]$Message)
  Write-Host "  [WARN] $Message" -ForegroundColor Yellow
}

function Write-Fail {
  param([string]$Message)
  Write-Host "  [FAIL] $Message" -ForegroundColor Red
  $script:ExitCode = 1
}

function Get-Api {
  param([string]$Path)

  $url = "$BaseUrl$Path"
  try {
    return Invoke-RestMethod -Uri $url -TimeoutSec 15 -ErrorAction Stop
  }
  catch {
    Write-Fail "$Path HTTP error: $($_.Exception.Message)"
    return $null
  }
}

function Short-Hash {
  param($Value)
  if (-not $Value) { return "null" }
  $text = [string]$Value
  if ($text.Length -le 8) { return $text }
  return $text.Substring(0, 8)
}

Write-Host ""
Write-Host "Francis Investment Health Check" -ForegroundColor Cyan
Write-Host "Server: $BaseUrl" -ForegroundColor DarkGray
Write-Host "Time:   $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray

$status = Get-Api "/api/status"
Write-Section "/api/status"
if ($status) {
  if ($status.version) { Write-Ok "version=$($status.version)" } else { Write-Fail "version missing" }
  if ($status.buildCommit) { Write-Ok "buildCommit=$(Short-Hash $status.buildCommit)" } else { Write-Fail "buildCommit missing" }
  Write-Ok "deployCommit=$(Short-Hash $status.deployCommit)"
  if ($status.deployManifestValid -eq $true) { Write-Ok "deployManifestValid=true" } else { Write-Warn "deployManifestValid=$($status.deployManifestValid)" }
  Write-Ok "identityStatus=$($status.identityStatus)"
  if ($status.scheduler) {
    Write-Ok "scheduler.state=$($status.scheduler.state)"
    Write-Ok "lastPipeline=$($status.scheduler.lastPipeline)"
    Write-Ok "lastMidScan=$($status.scheduler.lastMidScan)"
  }
}

$cockpit = Get-Api "/api/cockpit"
Write-Section "/api/cockpit"
if ($cockpit) {
  $rl = $cockpit.researchLab
  if ($rl) {
    Write-Ok "researchLab.status=$($rl.status)"
    Write-Ok "researchLab.statusLabel=$($rl.statusLabel)"
    if ($rl.h1Rejection) { Write-Ok "H1 rejected aggregateRankIC=$($rl.h1Rejection.aggregateRankIC)" } else { Write-Warn "H1 rejection missing" }
    if ($rl.h2Rejection) { Write-Ok "H2 rejected rankIC=$($rl.h2Rejection.rankIC), pValue=$($rl.h2Rejection.pValue)" } else { Write-Warn "H2 rejection missing" }
    if ($rl.h3Smoke) { Write-Ok "H3 smoke status=$($rl.h3Smoke.status)" } else { Write-Warn "H3 smoke block missing" }
    if ($rl.researchGate) {
      Write-Ok "researchGate.next=$($rl.researchGate.nextRequiredGate)"
      if ($rl.researchGate.rejectionHistory) {
        Write-Ok "researchGate.rejections=$($rl.researchGate.rejectionHistory.Count)"
      }
    } else {
      Write-Warn "researchGate missing"
    }
    if ($rl.canonicalCohort) {
      Write-Ok "canonical=$($rl.canonicalCohort.date), completed=$($rl.canonicalCohort.completed), runId=$($rl.canonicalCohort.runId)"
    }
  } else {
    Write-Fail "researchLab missing"
  }
}

$settlement = Get-Api "/api/prediction-settlement"
Write-Section "/api/prediction-settlement"
if ($settlement) {
  Write-Ok "top50=$($settlement.top50)"
  Write-Ok "predictionValid=$($settlement.predictionValid)"
  Write-Ok "researchEligible=$($settlement.researchEligible)"
  Write-Ok "expectedReturnInjected=$($settlement.expectedReturnInjected)"
  Write-Ok "missingExpectedReturn=$($settlement.missingExpectedReturn)"
  Write-Ok "predictionSource=$($settlement.predictionSource)"
  Write-Ok "canonicalCohortCount=$($settlement.canonicalCohortCount)"
  Write-Ok "intradayObservationCount=$($settlement.intradayObservationCount)"
}

$cohort = Get-Api "/api/cohort-integrity"
Write-Section "/api/cohort-integrity"
if ($cohort) {
  Write-Ok "hasManifest=$($cohort.hasManifest)"
  Write-Ok "canonicalCohortCount=$($cohort.canonicalCohortCount)"
  Write-Ok "intradayCount=$($cohort.intradayCount)"
  if ($cohort.manifest) {
    Write-Ok "manifest.status=$($cohort.manifest.status), runId=$($cohort.manifest.canonicalRunId), buildCommit=$(Short-Hash $cohort.manifest.buildCommit)"
  }
  if ($cohort.counts) {
    Write-Ok "counts.predictionValid=$($cohort.counts.predictionValid)"
    Write-Ok "counts.researchEligible=$($cohort.counts.researchEligible)"
    Write-Ok "counts.expectedReturnInjected=$($cohort.counts.expectedReturnInjected)"
    Write-Ok "counts.missingExpectedReturn=$($cohort.counts.missingExpectedReturn)"
  }
  Write-Ok "predictionSource=$($cohort.predictionSource)"
}

$decision = Get-Api "/api/think-tank/decision-status"
Write-Section "/api/think-tank/decision-status"
if ($decision) {
  if ($decision.marketState) { Write-Ok "marketState=$($decision.marketState.state)" }
  if ($decision.kernelVerdict) {
    Write-Ok "finalVerdict=$($decision.kernelVerdict.finalVerdict)"
    Write-Ok "canBuy=$($decision.kernelVerdict.canBuy)"
    Write-Ok "maxBuysPerDay=$($decision.kernelVerdict.maxBuysPerDay)"
    if ($decision.kernelVerdict.hardBlockers) {
      Write-Warn "hardBlockers=$($decision.kernelVerdict.hardBlockers.Count)"
      foreach ($blocker in $decision.kernelVerdict.hardBlockers) {
        Write-Warn "$($blocker.gate): $($blocker.reason)"
      }
    }
  }
  if ($decision.decisionGates) {
    Write-Ok "liveModel=$($decision.decisionGates.liveModel.liveModelStatus)"
    Write-Ok "leakageAudit=$($decision.decisionGates.leakageAudit.verdict)"
    Write-Ok "strategyHealth=$($decision.decisionGates.strategyHealth.verdict)"
  }
}

Write-Section "Summary"
if ($script:ExitCode -eq 0) {
  Write-Ok "Health check completed"
} else {
  Write-Fail "Health check found blocking errors"
}

exit $script:ExitCode
