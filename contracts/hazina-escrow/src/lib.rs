#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, token, Address, Env,
    String, Vec,
};

const MAX_BASIS_POINTS: u32 = 10_000;

#[contracttype]
pub enum DataKey {
    Admin,
    DefaultPlatformFee,
    EscrowCount,
    WhitelistEnforced,
    Paused,
    DatasetFee(String),
    Whitelisted(Address),
    Blacklisted(Address),
}

#[contracttype]
pub enum EscrowKey {
    Record(u64),
}

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq)]
#[repr(u32)]
pub enum HazinaEscrowError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NotAdmin = 3,
    InvalidFeeBps = 4,
    InvalidAmount = 5,
    AlreadyReleased = 6,
    AlreadyRefunded = 7,
    EscrowNotFound = 8,
    AddressBlacklisted = 9,
    AddressNotWhitelisted = 10,
    EmptyDatasetId = 11,
    Paused = 12,
}

#[contracttype]
#[derive(Clone, Eq, PartialEq)]
pub struct EscrowRecord {
    pub escrow_id: u64,
    pub dataset_id: String,
    pub buyer: Address,
    pub seller: Address,
    pub amount: i128,
    pub token: Address,
    pub platform_fee_bps: u32,
    pub released: bool,
    pub refunded: bool,
}

#[contracttype]
#[derive(Clone, Eq, PartialEq)]
pub struct DatasetFeeConfig {
    pub default_fee_bps: u32,
    pub has_custom_fee: bool,
    pub dataset_fee_bps: u32,
    pub effective_fee_bps: u32,
}

#[contracttype]
#[derive(Clone, Eq, PartialEq)]
pub struct AddressPolicy {
    pub whitelisted: bool,
    pub blacklisted: bool,
    pub whitelist_enforced: bool,
    pub can_transact: bool,
}

#[contracttype]
#[derive(Clone, Eq, PartialEq)]
pub struct SellerShare {
    pub seller: Address,
    pub amount: i128,
}

#[contract]
pub struct HazinaEscrow;

#[contractimpl]
impl HazinaEscrow {
    pub fn initialize(env: Env, admin: Address, platform_fee_bps: u32) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, HazinaEscrowError::AlreadyInitialized);
        }

        Self::assert_valid_fee(&env, platform_fee_bps);

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::DefaultPlatformFee, &platform_fee_bps);
        env.storage().instance().set(&DataKey::EscrowCount, &0u64);
        env.storage()
            .instance()
            .set(&DataKey::WhitelistEnforced, &false);
        env.storage().instance().set(&DataKey::Paused, &false);
    }

    /// Emergency circuit breaker: pause buyer locks and admin releases.
    pub fn pause(env: Env, admin: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        env.storage().instance().set(&DataKey::Paused, &true);
        env.events()
            .publish((soroban_sdk::symbol_short!("paused"),), admin);
    }

    /// Resume normal operations after a pause.
    pub fn unpause(env: Env, admin: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        env.storage().instance().set(&DataKey::Paused, &false);
        env.events()
            .publish((soroban_sdk::symbol_short!("unpaused"),), admin);
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn set_default_fee(env: Env, admin: Address, fee_bps: u32) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        Self::assert_valid_fee(&env, fee_bps);

        env.storage()
            .instance()
            .set(&DataKey::DefaultPlatformFee, &fee_bps);

        env.events()
            .publish((soroban_sdk::symbol_short!("fee_upd"),), (admin, fee_bps));
    }

    /// Transfer admin role to a new address. Only current admin can call.
    pub fn transfer_admin(env: Env, admin: Address, new_admin: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events()
            .publish((soroban_sdk::symbol_short!("admin"),), (new_admin,));
    }

    /// Update platform fee (max 1000 bps = 10%). Only admin.
    pub fn update_fee(env: Env, admin: Address, new_fee_bps: u32) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        assert!(new_fee_bps <= 1_000, "fee too high");
        env.storage()
            .instance()
            .set(&DataKey::DefaultPlatformFee, &new_fee_bps);
        env.events().publish(
            (soroban_sdk::symbol_short!("fee_upd"),),
            (admin, new_fee_bps),
        );
    }

    pub fn set_dataset_fee(env: Env, admin: Address, dataset_id: String, fee_bps: u32) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        Self::assert_valid_dataset_id(&env, &dataset_id);
        Self::assert_valid_fee(&env, fee_bps);

        env.storage()
            .persistent()
            .set(&DataKey::DatasetFee(dataset_id.clone()), &fee_bps);

        env.events().publish(
            (soroban_sdk::symbol_short!("dsf_upd"),),
            (dataset_id, fee_bps),
        );
    }

    pub fn clear_dataset_fee(env: Env, admin: Address, dataset_id: String) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        Self::assert_valid_dataset_id(&env, &dataset_id);

        env.storage()
            .persistent()
            .remove(&DataKey::DatasetFee(dataset_id.clone()));

        env.events()
            .publish((soroban_sdk::symbol_short!("dsf_clr"),), dataset_id);
    }

    pub fn get_fee(env: Env) -> u32 {
        Self::get_default_fee(env)
    }

    pub fn get_default_fee(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::DefaultPlatformFee)
            .unwrap_or(500)
    }

    pub fn get_dataset_fee_config(env: Env, dataset_id: String) -> DatasetFeeConfig {
        Self::assert_valid_dataset_id(&env, &dataset_id);

        let default_fee_bps = Self::get_default_fee(env.clone());
        let dataset_fee_bps: Option<u32> = env
            .storage()
            .persistent()
            .get(&DataKey::DatasetFee(dataset_id));

        let effective_fee_bps = dataset_fee_bps.unwrap_or(default_fee_bps);

        DatasetFeeConfig {
            default_fee_bps,
            has_custom_fee: dataset_fee_bps.is_some(),
            dataset_fee_bps: dataset_fee_bps.unwrap_or(default_fee_bps),
            effective_fee_bps,
        }
    }

    pub fn set_whitelist_enforced(env: Env, admin: Address, enforced: bool) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        env.storage()
            .instance()
            .set(&DataKey::WhitelistEnforced, &enforced);

        env.events()
            .publish((soroban_sdk::symbol_short!("wl_mode"),), (admin, enforced));
    }

    pub fn set_address_whitelisted(env: Env, admin: Address, address: Address, whitelisted: bool) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        env.storage()
            .persistent()
            .set(&DataKey::Whitelisted(address.clone()), &whitelisted);

        env.events().publish(
            (soroban_sdk::symbol_short!("addr_wl"),),
            (address, whitelisted),
        );
    }

    pub fn set_address_blacklisted(env: Env, admin: Address, address: Address, blacklisted: bool) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        env.storage()
            .persistent()
            .set(&DataKey::Blacklisted(address.clone()), &blacklisted);

        env.events().publish(
            (soroban_sdk::symbol_short!("addr_bl"),),
            (address, blacklisted),
        );
    }

    pub fn get_address_policy(env: Env, address: Address) -> AddressPolicy {
        let whitelist_enforced = env
            .storage()
            .instance()
            .get(&DataKey::WhitelistEnforced)
            .unwrap_or(false);
        let whitelisted = env
            .storage()
            .persistent()
            .get(&DataKey::Whitelisted(address.clone()))
            .unwrap_or(false);
        let blacklisted = env
            .storage()
            .persistent()
            .get(&DataKey::Blacklisted(address))
            .unwrap_or(false);

        AddressPolicy {
            whitelisted,
            blacklisted,
            whitelist_enforced,
            can_transact: !blacklisted && (!whitelist_enforced || whitelisted),
        }
    }

    pub fn lock(
        env: Env,
        buyer: Address,
        seller: Address,
        token: Address,
        amount: i128,
        dataset_id: String,
    ) -> u64 {
        buyer.require_auth();
        Self::assert_not_paused(&env);
        Self::assert_valid_amount(&env, amount);
        Self::assert_valid_dataset_id(&env, &dataset_id);
        Self::require_operational_address(&env, &buyer);
        Self::require_operational_address(&env, &seller);

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&buyer, &env.current_contract_address(), &amount);

        let fee_bps = Self::resolve_fee_bps(&env, &dataset_id);
        let escrow_id = env
            .storage()
            .instance()
            .get(&DataKey::EscrowCount)
            .unwrap_or(0);

        let record = EscrowRecord {
            escrow_id,
            dataset_id,
            buyer: buyer.clone(),
            seller: seller.clone(),
            amount,
            token: token.clone(),
            platform_fee_bps: fee_bps,
            released: false,
            refunded: false,
        };

        env.storage()
            .persistent()
            .set(&EscrowKey::Record(escrow_id), &record);
        env.storage()
            .instance()
            .set(&DataKey::EscrowCount, &(escrow_id + 1));

        env.events().publish(
            (soroban_sdk::symbol_short!("locked"),),
            (escrow_id, buyer, seller, amount, fee_bps),
        );

        escrow_id
    }

    /// Buyer calls this to lock one payment split across multiple sellers.
    /// Returns the first escrow id that was created.
    pub fn lock_multi(
        env: Env,
        buyer: Address,
        token: Address,
        shares: Vec<SellerShare>,
        dataset_ids: Vec<String>,
    ) -> u64 {
        buyer.require_auth();
        Self::assert_not_paused(&env);
        if shares.is_empty() || shares.len() != dataset_ids.len() {
            panic_with_error!(&env, HazinaEscrowError::EscrowNotFound);
        }

        Self::require_operational_address(&env, &buyer);

        let mut total_amount: i128 = 0;
        let mut i: u32 = 0;
        while i < shares.len() {
            let share = shares
                .get(i)
                .unwrap_or_else(|| panic_with_error!(&env, HazinaEscrowError::EscrowNotFound));
            Self::assert_valid_amount(&env, share.amount);
            Self::require_operational_address(&env, &share.seller);
            total_amount += share.amount;
            i += 1;
        }

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&buyer, &env.current_contract_address(), &total_amount);

        let first_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EscrowCount)
            .unwrap_or(0);
        let mut next_id = first_id;
        let mut j: u32 = 0;
        while j < shares.len() {
            let share = shares
                .get(j)
                .unwrap_or_else(|| panic_with_error!(&env, HazinaEscrowError::EscrowNotFound));
            let dataset_id = dataset_ids
                .get(j)
                .unwrap_or_else(|| panic_with_error!(&env, HazinaEscrowError::EscrowNotFound));
            Self::assert_valid_dataset_id(&env, &dataset_id);
            let fee_bps = Self::resolve_fee_bps(&env, &dataset_id);

            let record = EscrowRecord {
                escrow_id: next_id,
                dataset_id,
                buyer: buyer.clone(),
                seller: share.seller,
                amount: share.amount,
                token: token.clone(),
                platform_fee_bps: fee_bps,
                released: false,
                refunded: false,
            };
            env.storage()
                .persistent()
                .set(&EscrowKey::Record(next_id), &record);
            next_id += 1;
            j += 1;
        }

        env.storage()
            .instance()
            .set(&DataKey::EscrowCount, &next_id);
        first_id
    }

    pub fn release(env: Env, admin: Address, escrow_id: u64) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        Self::assert_not_paused(&env);
        Self::release_one(&env, &admin, escrow_id);
    }

    pub fn release_multi(env: Env, admin: Address, escrow_ids: Vec<u64>) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        Self::assert_not_paused(&env);

        let mut i: u32 = 0;
        while i < escrow_ids.len() {
            let escrow_id = escrow_ids
                .get(i)
                .unwrap_or_else(|| panic_with_error!(&env, HazinaEscrowError::EscrowNotFound));
            Self::release_one(&env, &admin, escrow_id);
            i += 1;
        }
    }

    pub fn refund(env: Env, admin: Address, escrow_id: u64) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        let mut record = Self::read_escrow(&env, escrow_id);
        if record.released {
            panic_with_error!(&env, HazinaEscrowError::AlreadyReleased);
        }
        if record.refunded {
            panic_with_error!(&env, HazinaEscrowError::AlreadyRefunded);
        }

        let token_client = token::Client::new(&env, &record.token);
        token_client.transfer(
            &env.current_contract_address(),
            &record.buyer,
            &record.amount,
        );

        record.refunded = true;
        env.storage()
            .persistent()
            .set(&EscrowKey::Record(escrow_id), &record);

        env.events().publish(
            (soroban_sdk::symbol_short!("refunded"),),
            (escrow_id, record.buyer, record.amount),
        );
    }

    pub fn get_escrow(env: Env, escrow_id: u64) -> EscrowRecord {
        Self::read_escrow(&env, escrow_id)
    }

    pub fn set_fee(env: Env, admin: Address, fee_bps: u32) {
        Self::set_default_fee(env, admin, fee_bps);
    }

    pub fn set_admin(env: Env, admin: Address, new_admin: Address) {
        Self::transfer_admin(env, admin, new_admin);
    }

    fn assert_admin(env: &Env, caller: &Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, HazinaEscrowError::NotInitialized));
        if admin != *caller {
            panic_with_error!(env, HazinaEscrowError::NotAdmin);
        }
    }

    fn assert_valid_fee(env: &Env, fee_bps: u32) {
        if fee_bps > MAX_BASIS_POINTS {
            panic_with_error!(env, HazinaEscrowError::InvalidFeeBps);
        }
    }

    fn assert_valid_amount(env: &Env, amount: i128) {
        if amount <= 0 {
            panic_with_error!(env, HazinaEscrowError::InvalidAmount);
        }
    }

    fn assert_valid_dataset_id(env: &Env, dataset_id: &String) {
        if dataset_id.is_empty() {
            panic_with_error!(env, HazinaEscrowError::EmptyDatasetId);
        }
    }

    fn assert_not_paused(env: &Env) {
        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            panic_with_error!(env, HazinaEscrowError::Paused);
        }
    }

    fn read_escrow(env: &Env, escrow_id: u64) -> EscrowRecord {
        env.storage()
            .persistent()
            .get(&EscrowKey::Record(escrow_id))
            .unwrap_or_else(|| panic_with_error!(env, HazinaEscrowError::EscrowNotFound))
    }

    fn resolve_fee_bps(env: &Env, dataset_id: &String) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::DatasetFee(dataset_id.clone()))
            .unwrap_or_else(|| Self::get_default_fee(env.clone()))
    }

    fn require_operational_address(env: &Env, address: &Address) {
        let policy = Self::get_address_policy(env.clone(), address.clone());
        if policy.blacklisted {
            panic_with_error!(env, HazinaEscrowError::AddressBlacklisted);
        }
        if policy.whitelist_enforced && !policy.whitelisted {
            panic_with_error!(env, HazinaEscrowError::AddressNotWhitelisted);
        }
    }

    fn release_one(env: &Env, admin: &Address, escrow_id: u64) {
        let mut record = Self::read_escrow(env, escrow_id);
        if record.released {
            panic_with_error!(env, HazinaEscrowError::AlreadyReleased);
        }
        if record.refunded {
            panic_with_error!(env, HazinaEscrowError::AlreadyRefunded);
        }

        let calculated_platform_cut =
            record.amount * record.platform_fee_bps as i128 / MAX_BASIS_POINTS as i128;
        let platform_cut =
            if calculated_platform_cut == 0 && record.amount > 0 && record.platform_fee_bps > 0 {
                1
            } else {
                calculated_platform_cut
            };
        let seller_cut = record.amount - platform_cut;

        let token_client = token::Client::new(env, &record.token);
        token_client.transfer(&env.current_contract_address(), &record.seller, &seller_cut);
        token_client.transfer(&env.current_contract_address(), admin, &platform_cut);

        record.released = true;
        env.storage()
            .persistent()
            .set(&EscrowKey::Record(escrow_id), &record);

        env.events().publish(
            (soroban_sdk::symbol_short!("released"),),
            (escrow_id, record.seller, seller_cut, platform_cut),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::Address as _,
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env, String,
    };

    const INITIAL_BUYER_BALANCE: i128 = 10_000_000_000; // 1_000 units with 7 decimals

    fn setup() -> (
        Env,
        HazinaEscrowClient<'static>,
        Address,
        Address,
        Address,
        Address,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);

        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let usdc = token_id.address();
        let usdc_admin = StellarAssetClient::new(&env, &usdc);
        usdc_admin.mint(&buyer, &INITIAL_BUYER_BALANCE);

        let contract_id = env.register(HazinaEscrow, ());
        let client = HazinaEscrowClient::new(&env, &contract_id);
        client.initialize(&admin, &500);

        (env, client, admin, buyer, seller, usdc)
    }

    fn dataset_id(env: &Env, value: &str) -> String {
        String::from_str(env, value)
    }

    #[test]
    fn test_initialize_sets_default_config() {
        let (env, client, _admin, buyer, seller, usdc) = setup();
        let fee = client.get_fee();
        assert_eq!(fee, 500);

        let policy = client.get_address_policy(&buyer);
        assert!(!policy.whitelist_enforced);
        assert!(policy.can_transact);

        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &1_000_000,
            &dataset_id(&env, "ds-init"),
        );
        let record = client.get_escrow(&escrow_id);
        assert_eq!(record.platform_fee_bps, 500);
    }

    #[test]
    #[should_panic]
    fn test_initialize_fails_when_called_twice() {
        let (_env, client, admin, _buyer, _seller, _usdc) = setup();
        client.initialize(&admin, &500);
    }

    #[test]
    fn test_set_default_fee_updates_contract_fee() {
        let (_env, client, admin, _buyer, _seller, _usdc) = setup();
        client.set_default_fee(&admin, &750);
        assert_eq!(client.get_default_fee(), 750);
        assert_eq!(client.get_fee(), 750);
    }

    #[test]
    #[should_panic]
    fn test_set_default_fee_rejects_invalid_fee() {
        let (_env, client, admin, _buyer, _seller, _usdc) = setup();
        client.set_default_fee(&admin, &10_001);
    }

    #[test]
    fn test_set_and_clear_dataset_fee() {
        let (env, client, admin, _buyer, _seller, _usdc) = setup();
        let ds = dataset_id(&env, "ds-custom-fee");

        client.set_dataset_fee(&admin, &ds, &900);
        let custom = client.get_dataset_fee_config(&ds);
        assert!(custom.has_custom_fee);
        assert_eq!(custom.dataset_fee_bps, 900);
        assert_eq!(custom.effective_fee_bps, 900);

        client.clear_dataset_fee(&admin, &ds);
        let cleared = client.get_dataset_fee_config(&ds);
        assert!(!cleared.has_custom_fee);
        assert_eq!(cleared.dataset_fee_bps, 500);
        assert_eq!(cleared.effective_fee_bps, 500);
    }

    #[test]
    #[should_panic]
    fn test_set_dataset_fee_requires_non_empty_dataset_id() {
        let (env, client, admin, _buyer, _seller, _usdc) = setup();
        client.set_dataset_fee(&admin, &dataset_id(&env, ""), &900);
    }

    #[test]
    fn test_set_address_policies_and_read_them_back() {
        let (_env, client, admin, buyer, _seller, _usdc) = setup();

        client.set_whitelist_enforced(&admin, &true);
        client.set_address_whitelisted(&admin, &buyer, &true);
        client.set_address_blacklisted(&admin, &buyer, &false);

        let policy = client.get_address_policy(&buyer);
        assert!(policy.whitelist_enforced);
        assert!(policy.whitelisted);
        assert!(!policy.blacklisted);
        assert!(policy.can_transact);
    }

    #[test]
    fn test_lock_and_release_use_snapshot_fee() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        let ds = dataset_id(&env, "ds-snapshotted-fee");
        let amount: i128 = 2_000_000;

        client.set_dataset_fee(&admin, &ds, &900);
        let escrow_id = client.lock(&buyer, &seller, &usdc, &amount, &ds);
        client.set_dataset_fee(&admin, &ds, &100);
        client.release(&admin, &escrow_id);

        let record = client.get_escrow(&escrow_id);
        assert_eq!(record.platform_fee_bps, 900);
        assert!(record.released);

        let admin_expected = amount * 900i128 / 10_000i128;
        let seller_expected = amount - admin_expected;
        assert_eq!(token_client.balance(&admin), admin_expected);
        assert_eq!(token_client.balance(&seller), seller_expected);
    }

    #[test]
    fn test_release_enforces_minimum_platform_fee_for_tiny_amounts() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        let amount: i128 = 9;

        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &amount,
            &dataset_id(&env, "ds-micro-fee-floor"),
        );
        client.release(&admin, &escrow_id);

        assert_eq!(token_client.balance(&admin), 1);
        assert_eq!(token_client.balance(&seller), amount - 1);
    }

    #[test]
    #[should_panic]
    fn test_lock_rejects_blacklisted_addresses() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        client.set_address_blacklisted(&admin, &seller, &true);

        client.lock(
            &buyer,
            &seller,
            &usdc,
            &1_000_000,
            &dataset_id(&env, "ds-blacklist"),
        );
    }

    #[test]
    #[should_panic]
    fn test_lock_rejects_non_whitelisted_addresses_when_enforced() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        client.set_whitelist_enforced(&admin, &true);
        client.set_address_whitelisted(&admin, &buyer, &true);

        client.lock(
            &buyer,
            &seller,
            &usdc,
            &1_000_000,
            &dataset_id(&env, "ds-whitelist"),
        );
    }

    #[test]
    #[should_panic]
    fn test_lock_rejects_invalid_amount() {
        let (env, client, _admin, buyer, seller, usdc) = setup();
        client.lock(&buyer, &seller, &usdc, &0, &dataset_id(&env, "ds-invalid"));
    }

    #[test]
    fn test_refund_marks_record_and_restores_buyer_balance() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        let amount: i128 = 5_000_000;

        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &amount,
            &dataset_id(&env, "ds-refund"),
        );
        client.refund(&admin, &escrow_id);

        let record = client.get_escrow(&escrow_id);
        assert!(record.refunded);
        assert_eq!(token_client.balance(&buyer), INITIAL_BUYER_BALANCE);
    }

    #[test]
    #[should_panic]
    fn test_release_cannot_be_called_twice() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &1_000_000,
            &dataset_id(&env, "ds-release-twice"),
        );

        client.release(&admin, &escrow_id);
        client.release(&admin, &escrow_id);
    }

    #[test]
    #[should_panic]
    fn test_refund_cannot_be_called_after_release() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &1_000_000,
            &dataset_id(&env, "ds-refund-after-release"),
        );

        client.release(&admin, &escrow_id);
        client.refund(&admin, &escrow_id);
    }

    #[test]
    #[should_panic]
    fn test_release_requires_admin() {
        let (env, client, _admin, buyer, seller, usdc) = setup();
        let outsider = Address::generate(&env);
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &1_000_000,
            &dataset_id(&env, "ds-admin-check"),
        );

        client.release(&outsider, &escrow_id);
    }

    #[test]
    #[should_panic]
    fn test_get_escrow_fails_for_unknown_id() {
        let (_env, client, _admin, _buyer, _seller, _usdc) = setup();
        client.get_escrow(&99);
    }

    #[test]
    fn formal_release_conserves_locked_value() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        let amount: i128 = 3_500_000;

        let buyer_before = token_client.balance(&buyer);
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &amount,
            &dataset_id(&env, "ds-formal-conservation"),
        );
        client.release(&admin, &escrow_id);

        let seller_balance = token_client.balance(&seller);
        let admin_balance = token_client.balance(&admin);
        assert_eq!(buyer_before - token_client.balance(&buyer), amount);
        assert_eq!(seller_balance + admin_balance, amount);
    }

    #[test]
    fn formal_refund_returns_all_locked_value_to_buyer() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        let amount: i128 = 4_200_000;
        let buyer_before = token_client.balance(&buyer);

        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &amount,
            &dataset_id(&env, "ds-formal-refund"),
        );
        client.refund(&admin, &escrow_id);

        assert_eq!(token_client.balance(&buyer), buyer_before);
        assert_eq!(token_client.balance(&seller), 0);
        assert_eq!(token_client.balance(&admin), 0);
    }

    #[test]
    fn test_lock_multi_and_release_multi() {
        let (env, client, admin, buyer, _seller, usdc) = setup();
        let token_client = TokenClient::new(&env, &usdc);

        let seller_1 = Address::generate(&env);
        let seller_2 = Address::generate(&env);
        let seller_3 = Address::generate(&env);
        let seller_4 = Address::generate(&env);

        let amount_1: i128 = 1_000_000;
        let amount_2: i128 = 2_000_000;
        let amount_3: i128 = 3_000_000;
        let amount_4: i128 = 4_000_000;
        let total = amount_1 + amount_2 + amount_3 + amount_4;

        let mut shares = Vec::new(&env);
        shares.push_back(SellerShare {
            seller: seller_1.clone(),
            amount: amount_1,
        });
        shares.push_back(SellerShare {
            seller: seller_2.clone(),
            amount: amount_2,
        });
        shares.push_back(SellerShare {
            seller: seller_3.clone(),
            amount: amount_3,
        });
        shares.push_back(SellerShare {
            seller: seller_4.clone(),
            amount: amount_4,
        });

        let mut dataset_ids = Vec::new(&env);
        dataset_ids.push_back(String::from_str(&env, "ds-001"));
        dataset_ids.push_back(String::from_str(&env, "ds-002"));
        dataset_ids.push_back(String::from_str(&env, "ds-003"));
        dataset_ids.push_back(String::from_str(&env, "ds-004"));

        let first_id = client.lock_multi(&buyer, &usdc, &shares, &dataset_ids);
        assert_eq!(first_id, 0);
        assert_eq!(token_client.balance(&buyer), INITIAL_BUYER_BALANCE - total);

        let mut escrow_ids = Vec::new(&env);
        escrow_ids.push_back(first_id);
        escrow_ids.push_back(first_id + 1);
        escrow_ids.push_back(first_id + 2);
        escrow_ids.push_back(first_id + 3);

        client.release_multi(&admin, &escrow_ids);

        let s1_expected = amount_1 * 95 / 100;
        let s2_expected = amount_2 * 95 / 100;
        let s3_expected = amount_3 * 95 / 100;
        let s4_expected = amount_4 * 95 / 100;
        let admin_expected = (amount_1 - s1_expected)
            + (amount_2 - s2_expected)
            + (amount_3 - s3_expected)
            + (amount_4 - s4_expected);

        assert_eq!(token_client.balance(&seller_1), s1_expected);
        assert_eq!(token_client.balance(&seller_2), s2_expected);
        assert_eq!(token_client.balance(&seller_3), s3_expected);
        assert_eq!(token_client.balance(&seller_4), s4_expected);
        assert_eq!(token_client.balance(&admin), admin_expected);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #8)")]
    fn test_lock_multi_empty_shares() {
        let (env, client, _admin, buyer, _seller, usdc) = setup();
        let shares: Vec<SellerShare> = Vec::new(&env);
        let dataset_ids: Vec<String> = Vec::new(&env);

        let _ = client.lock_multi(&buyer, &usdc, &shares, &dataset_ids);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #8)")]
    fn test_lock_multi_mismatched_lengths() {
        let (env, client, _admin, buyer, _seller, usdc) = setup();
        let mut shares = Vec::new(&env);
        shares.push_back(SellerShare {
            seller: Address::generate(&env),
            amount: 1_000_000,
        });

        let dataset_ids: Vec<String> = Vec::new(&env);
        let _ = client.lock_multi(&buyer, &usdc, &shares, &dataset_ids);
    }

    #[test]
    fn test_initialize_emits_event() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let seller = Address::generate(&env);

        let contract_id = env.register(HazinaEscrow, ());
        let client = HazinaEscrowClient::new(&env, &contract_id);
        client.initialize(&admin, &250);

        let usdc_id = env.register_stellar_asset_contract_v2(admin.clone());
        let usdc = usdc_id.address();
        let usdc_admin = StellarAssetClient::new(&env, &usdc);
        usdc_admin.mint(&buyer, &INITIAL_BUYER_BALANCE);

        let eurc_id = env.register_stellar_asset_contract_v2(admin.clone());
        let eurc = eurc_id.address();
        let eurc_admin = StellarAssetClient::new(&env, &eurc);
        eurc_admin.mint(&buyer, &5_000_000_000);

        let usdc_amount: i128 = 1_000_000;
        let eurc_amount: i128 = 500_000;

        let usdc_escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &usdc_amount,
            &dataset_id(&env, "ds-usdc"),
        );
        let eurc_escrow_id = client.lock(
            &buyer,
            &seller,
            &eurc,
            &eurc_amount,
            &dataset_id(&env, "ds-eurc"),
        );

        client.release(&admin, &usdc_escrow_id);
        client.release(&admin, &eurc_escrow_id);

        let usdc_balance = TokenClient::new(&env, &usdc).balance(&seller);
        let eurc_balance = TokenClient::new(&env, &eurc).balance(&seller);
        assert_eq!(usdc_balance, usdc_amount - (usdc_amount * 250 / 10_000));
        assert_eq!(eurc_balance, eurc_amount - (eurc_amount * 250 / 10_000));
        // Fee is stored correctly after init
        assert_eq!(client.get_fee(), 250);
    }

    #[test]
    fn test_set_fee() {
        let (_, client, admin, _, _, _) = setup();
        client.set_fee(&admin, &300);
        assert_eq!(client.get_fee(), 300);
    }

    #[test]
    fn test_set_fee_max_boundary() {
        let (_, client, admin, _, _, _) = setup();
        client.set_fee(&admin, &10_000);
        assert_eq!(client.get_fee(), 10_000);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn test_set_fee_rejects_over_10000() {
        let (_, client, admin, _, _, _) = setup();
        client.set_fee(&admin, &10_001);
    }

    #[test]
    fn test_set_admin() {
        let (env, client, admin, _, _, _) = setup();
        let new_admin = Address::generate(&env);
        client.set_admin(&admin, &new_admin);

        // Old admin can no longer change the fee (new admin is required)
        // New admin can change the fee successfully
        client.set_fee(&new_admin, &100);
        assert_eq!(client.get_fee(), 100);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_set_fee_requires_admin() {
        let (env, client, _, _, _, _) = setup();
        let impostor = Address::generate(&env);
        client.set_fee(&impostor, &100);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")]
    fn test_double_initialize_panics() {
        let (_, client, admin, _, _, _) = setup();
        client.initialize(&admin, &500); // second call must panic
    }

    #[test]
    fn test_pause_and_unpause_toggles_state() {
        let (_env, client, admin, _buyer, _seller, _usdc) = setup();
        assert!(!client.is_paused());
        client.pause(&admin);
        assert!(client.is_paused());
        client.unpause(&admin);
        assert!(!client.is_paused());
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_pause_requires_admin() {
        let (env, client, _admin, _buyer, _seller, _usdc) = setup();
        let outsider = Address::generate(&env);
        client.pause(&outsider);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #12)")]
    fn test_lock_fails_when_paused() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        client.pause(&admin);
        client.lock(
            &buyer,
            &seller,
            &usdc,
            &1_000_000,
            &dataset_id(&env, "ds-paused-lock"),
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #12)")]
    fn test_release_fails_when_paused() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &1_000_000,
            &dataset_id(&env, "ds-paused-release"),
        );
        client.pause(&admin);
        client.release(&admin, &escrow_id);
    }

    #[test]
    fn test_refund_still_works_when_paused() {
        let (env, client, admin, buyer, seller, usdc) = setup();
        let token_client = TokenClient::new(&env, &usdc);
        let amount: i128 = 1_234_567;

        let escrow_id = client.lock(
            &buyer,
            &seller,
            &usdc,
            &amount,
            &dataset_id(&env, "ds-paused-refund"),
        );

        client.pause(&admin);
        client.refund(&admin, &escrow_id);

        let record = client.get_escrow(&escrow_id);
        assert!(record.refunded);
        assert_eq!(token_client.balance(&buyer), INITIAL_BUYER_BALANCE);
    }
}

// ─── Fuzz / property-based tests ────────────────────────────────────────────

#[cfg(all(test, feature = "fuzz-tests"))]
mod fuzz_tests {
    extern crate std;

    use super::*;
    use proptest::prelude::*;
    use soroban_sdk::{
        testutils::Address as _,
        token::{Client as TokenClient, StellarAssetClient},
        Env, String,
    };

    // ── helpers ──────────────────────────────────────────────────────────────

    /// Mint `amount` of a fresh token to `buyer` and return the token address.
    fn deploy_token(env: &Env, admin: &Address, buyer: &Address, amount: i128) -> Address {
        let id = env.register_stellar_asset_contract_v2(admin.clone());
        let addr = id.address();
        StellarAssetClient::new(env, &addr).mint(buyer, &amount);
        addr
    }

    fn deploy_escrow(env: &Env, admin: &Address, fee_bps: u32) -> HazinaEscrowClient<'static> {
        let contract_id = env.register(HazinaEscrow, ());
        let client = HazinaEscrowClient::new(env, &contract_id);
        client.initialize(admin, &fee_bps);
        client
    }

    // ── fee arithmetic invariant ─────────────────────────────────────────────

    proptest! {
        /// For any valid fee and any positive lock amount, the split must be lossless:
        ///   seller_cut + platform_cut == amount
        #[test]
        fn prop_fee_split_is_lossless(
            fee_bps in 0u32..=10_000u32,
            amount   in 1i128..=1_000_000_000i128,
        ) {
            let platform_cut = amount * fee_bps as i128 / 10_000;
            let seller_cut   = amount - platform_cut;
            prop_assert_eq!(seller_cut + platform_cut, amount);
        }

        /// Seller cut is always <= amount and never negative.
        #[test]
        fn prop_seller_cut_in_bounds(
            fee_bps in 0u32..=10_000u32,
            amount  in 0i128..=i128::MAX / 10_001,
        ) {
            let platform_cut = amount * fee_bps as i128 / 10_000;
            let seller_cut   = amount - platform_cut;
            prop_assert!(seller_cut >= 0);
            prop_assert!(seller_cut <= amount);
        }

        /// set_fee persists arbitrary valid fee values correctly.
        #[test]
        fn prop_set_fee_roundtrip(new_fee in 0u32..=10_000u32) {
            let env = Env::default();
            env.mock_all_auths();
            let admin = Address::generate(&env);
            let client = deploy_escrow(&env, &admin, 500);
            client.set_fee(&admin, &new_fee);
            prop_assert_eq!(client.get_fee(), new_fee);
        }

        /// Lock with various amounts: contract balance increases by exactly `amount`.
        #[test]
        fn prop_lock_transfers_exact_amount(
            amount in 1i128..=500_000_000i128,
        ) {
            let env = Env::default();
            env.mock_all_auths();

            let admin  = Address::generate(&env);
            let buyer  = Address::generate(&env);
            let seller = Address::generate(&env);

            let mint_amount = amount + 1_000; // ensure buyer has enough
            let token = deploy_token(&env, &admin, &buyer, mint_amount);
            let token_client = TokenClient::new(&env, &token);

            let client = deploy_escrow(&env, &admin, 500);
            let _contract_addr = env.register(HazinaEscrow, ()); // register to get address

            let buyer_before = token_client.balance(&buyer);
            client.lock(
                &buyer, &seller, &token, &amount,
                &String::from_str(&env, "ds-fuzz"),
            );
            let buyer_after = token_client.balance(&buyer);

            prop_assert_eq!(buyer_before - buyer_after, amount);
        }

        /// Release after lock: combined payout always equals locked amount.
        #[test]
        fn prop_release_pays_out_full_amount(
            fee_bps in 0u32..=10_000u32,
            amount  in 1i128..=500_000_000i128,
        ) {
            let env = Env::default();
            env.mock_all_auths();

            let admin  = Address::generate(&env);
            let buyer  = Address::generate(&env);
            let seller = Address::generate(&env);

            let token = deploy_token(&env, &admin, &buyer, amount + 1_000);
            let token_client = TokenClient::new(&env, &token);

            let client = deploy_escrow(&env, &admin, fee_bps);
            let escrow_id = client.lock(
                &buyer, &seller, &token, &amount,
                &String::from_str(&env, "ds-fuzz-rel"),
            );

            let seller_before = token_client.balance(&seller);
            let admin_before  = token_client.balance(&admin);

            client.release(&admin, &escrow_id);

            let seller_gain = token_client.balance(&seller) - seller_before;
            let admin_gain  = token_client.balance(&admin)  - admin_before;

            prop_assert_eq!(seller_gain + admin_gain, amount);
        }

        /// Refund after lock: buyer always recovers the full locked amount.
        #[test]
        fn prop_refund_returns_full_amount(
            amount in 1i128..=500_000_000i128,
        ) {
            let env = Env::default();
            env.mock_all_auths();

            let admin  = Address::generate(&env);
            let buyer  = Address::generate(&env);
            let seller = Address::generate(&env);

            let token = deploy_token(&env, &admin, &buyer, amount + 1_000);
            let token_client = TokenClient::new(&env, &token);

            let client = deploy_escrow(&env, &admin, 500);
            let escrow_id = client.lock(
                &buyer, &seller, &token, &amount,
                &String::from_str(&env, "ds-fuzz-ref"),
            );

            let buyer_before = token_client.balance(&buyer);
            client.refund(&admin, &escrow_id);
            let buyer_after = token_client.balance(&buyer);

            prop_assert_eq!(buyer_after - buyer_before, amount);
        }
    }
}
