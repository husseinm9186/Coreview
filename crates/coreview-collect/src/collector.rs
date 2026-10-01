//! A run's sidecar, kept across its devices (LT-588, LT-589). One sidecar
//! serves device after device; when it stops answering — a command stuck
//! on a device, a crash — that device ends there, the process is killed,
//! and the next device gets a fresh one, so one bad device never ends the
//! run. Stop ends the device in progress at once and kills its sidecar,
//! whatever it was waiting on.

use tokio_util::sync::CancellationToken;

use coreview_catalog::Catalog;

use crate::run::{collect_device, DeviceRun, RunOptions, RunSink, Target};
use crate::sidecar::{Auth, Sidecar, SidecarLocation};

pub struct SidecarSlot {
    location: SidecarLocation,
    sidecar: Option<Sidecar>,
    /// LT-617: a replacement could not be started; the run should end.
    lost: bool,
}

impl SidecarSlot {
    pub fn new(location: SidecarLocation) -> Self {
        SidecarSlot { location, sidecar: None, lost: false }
    }

    /// With a sidecar the caller has already started.
    pub fn started(location: SidecarLocation, sidecar: Sidecar) -> Self {
        SidecarSlot { location, sidecar: Some(sidecar), lost: false }
    }

    /// Whether a sidecar could not be started: nothing more will be collected.
    pub fn lost(&self) -> bool {
        self.lost
    }

    /// One device. `None` when the run was cancelled while it was in
    /// progress; a sidecar that could not be started is the device's
    /// failure `sidecar`, with the reason in its log.
    pub async fn collect(&mut self, catalogs: &[Catalog], target: &Target, auth: &Auth, options: &RunOptions, sink: &dyn RunSink, cancel: &CancellationToken) -> Option<DeviceRun> {
        if cancel.is_cancelled() {
            return None;
        }
        if self.sidecar.is_none() {
            match Sidecar::spawn(&self.location).await {
                Ok(s) => self.sidecar = Some(s),
                Err(e) => {
                    self.lost = true;
                    let mut run = DeviceRun { host: target.host.clone(), failure: Some("sidecar".into()), ..Default::default() };
                    run.log.push(format!("the sidecar could not be started: {e}"));
                    return Some(run);
                }
            }
        }
        let sidecar = self.sidecar.as_mut().expect("started above");
        let run = tokio::select! {
            run = collect_device(sidecar, catalogs, target, auth, options, sink) => Some(run),
            _ = cancel.cancelled() => None,
        };
        match &run {
            // Cancelled mid-device, or the sidecar stopped answering: it may
            // still be busy with a command, so it is killed (dropping it does)
            // rather than asked anything more.
            None => self.sidecar = None,
            Some(r) if r.failure.as_deref() == Some("sidecar") => self.sidecar = None,
            _ => {}
        }
        run
    }

    /// Ask the sidecar to quit, if one is running.
    pub async fn quit(self) {
        if let Some(s) = self.sidecar {
            s.quit().await;
        }
    }
}
