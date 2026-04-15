package com.fsq.profile.service;

import com.fsq.profile.api.dto.ProfilePatchRequest;
import com.fsq.profile.api.dto.ProfileResponse;
import com.fsq.user.domain.User;

import java.util.Optional;

/**
 * 个人资料业务接口。
 */
public interface ProfileService {

    Optional<User> getById(long userId);

    ProfileResponse updateProfile(long userId, ProfilePatchRequest req);

    ProfileResponse updateAvatar(long userId, String avatarUrl);
}